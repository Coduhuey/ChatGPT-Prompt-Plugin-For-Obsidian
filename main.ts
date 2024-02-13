import { workerData } from 'worker_threads';
import { TFile, ViewState, Workspace, ItemView, addIcon, Menu, App, Editor, MarkdownView, Modal, Notice, Plugin, PluginSettingTab, Setting, WorkspaceLeaf, Vault, getAllTags, normalizePath, requestUrl } from 'obsidian';

interface Settings {
	api_key: string;
	tags: string[];
	path_to_prompt_template: string[];
	chatgpt_behavior: string;
	convo_retention: number;
	conversations: Object;
	last_convo: DatedConversation;
}

const DEFAULT_SETTINGS: Settings = {
	api_key: '',
	tags: [],
	path_to_prompt_template: [],
	chatgpt_behavior: 'You are a helpful assistant.',
	convo_retention: 10,
	conversations: {},
	last_convo: {conversations: [{role: "system", content: "You are a helpful assistant"}], last_updated: new Date().getTime()},
}

class Conversation{
	role: string;
	content: string;
}

class DatedConversation{
	conversations: Conversation[];
	last_updated: number;
}

export const VIEW_TYPE_CHATGPT_RESPONSE = "chatgpt-response-view";


export class ChatGptResponseView extends ItemView {
	display_text: string;
	conversation: DatedConversation;
	leaf: WorkspaceLeaf;
	plugin: PromptGptPlugin;
  constructor(leaf: WorkspaceLeaf, plugin : PromptGptPlugin) {
    super(leaf);
	
	this.plugin = plugin;
  }

  getViewType() {
    return VIEW_TYPE_CHATGPT_RESPONSE;
  }

  getDisplayText() {
    return this.display_text;
  }

  setDisplayText(conversation: DatedConversation) {
	this.conversation = conversation;

	const container = this.containerEl.children[1];
    container.empty();
    let containerEl = container.createEl("div", { text: "ChatGPT" });
	this.createChatUI(containerEl);
  }

  async onOpen() {
	await this.plugin.loadSettings();
	this.conversation = this.plugin.settings.last_convo;

    const container = this.containerEl.children[1];
    container.empty();
	container.addClass("main-container");
    let containerEl = container.createEl("div", { text: "ChatGPT" });
	this.createChatUI(containerEl);
  }

  async onClose() {
	this.plugin.setLastConvo(this.conversation);
  }

  createChatUI(container: HTMLElement) {

	const linebreak = container.createEl('div');
	linebreak.addClass("line-break");
	container.appendChild(linebreak);

	const chatDiv = container.createEl('div');
	chatDiv.addClass('chat-container');
  
	container.appendChild(chatDiv);
  
	const inputBox = container.createEl('input');
	inputBox.type = 'text';
	inputBox.placeholder = 'Type your message...';
	inputBox.addClass("input-box");
	

	if (this.conversation){
		this.displayConversation(chatDiv);
	}
  
	inputBox.addEventListener('keyup', (event) => {
	  if (event.key === 'Enter') {
		const userInput = inputBox.value;
		if (userInput) {
			this.conversation.conversations.push({ role: 'user', content: userInput});
			this.displayConversation(chatDiv);
			inputBox.value = '';


			//callChatGPT will automatically update the view
			this.plugin.callChatGPT(this.conversation).then((() => {
				this.displayConversation(chatDiv);
			}));
		}
		else{
			new Notice('Please enter a message.');
		}
	  }
	});
  
	container.appendChild(inputBox);
  
	return container;
  }

  displayConversation(chatDiv: HTMLElement) {
	
	this.conversation.conversations.map((msg) => {
		let div = chatDiv.createEl('div');
		let strong = div.createEl('strong', {text: this.capitalizeFirstLetter(msg.role)+"\n\n"});
		let formattedEl = this.formatContent(chatDiv, msg.content)
		div.appendChild(strong);
		div.appendChild(formattedEl);
		chatDiv.appendChild(div);
	});
	chatDiv.scrollTop = chatDiv.scrollHeight;
  }

  capitalizeFirstLetter(s : string) {
    return s.charAt(0).toUpperCase() + s.slice(1);
}

formatContent(chatDiv: HTMLElement, content: string) {
    // Split content into lines
	let innerDiv = chatDiv.createEl('ul');
    const lines = content.split('\n');

    // Convert lines into a structured list
    const listItems = lines.map((line) => {
		innerDiv.appendChild(innerDiv.createEl('span', {text: line}));
		innerDiv.appendChild(innerDiv.createEl('br'));
	});

    // Wrap the list items in an unordered list
    return innerDiv;
}
} 

export default class PromptGptPlugin extends Plugin {
	settings: Settings;
	conversations: Map<string, DatedConversation>;
	loaded: boolean = true;
	oldWorkspace: Workspace;
	//setting limit to 5000 characters, hopefully reduce amount of instances where user hits the api limit 
	//(max is 150,000 tokens per minute)
	max_context_length: number = 5000;

	setLastConvo(convo: DatedConversation){
		this.settings.last_convo = convo;
	}

	async onload() {

		await this.loadSettings();

		this.conversations = new Map(Object.entries(this.settings.conversations));


		// This adds a settings tab so the user can configure various aspects of the plugin
		this.addSettingTab(new SettingTab(this.app, this));

		this.addRibbonIcon('brain-circuit', 'Show/Hide ChatGPT', () => {
			const leaves = this.app.workspace.getLeavesOfType(VIEW_TYPE_CHATGPT_RESPONSE);

			if(leaves.length > 0){
				this.deactivateView();
				this.loaded = false;
			}
			else{
				this.activateView().then(() => {
					this.loaded = true;

				});
			}
		});

		this.registerView(
			VIEW_TYPE_CHATGPT_RESPONSE,
			(leaf) => new ChatGptResponseView(leaf, this)
		  );

		this.registerEvent(this.app.workspace.on('file-open', (file) => {
			if(!this.loaded){
				return;
			}
			if (file){
				if(file.name.substring(file.name.length - 3) !== '.md'){
					return;
				}

				if(this.conversations.has(file.name)){
					this.app.workspace.getLeavesOfType(VIEW_TYPE_CHATGPT_RESPONSE).forEach((leaf) => {
						if (leaf.view instanceof ChatGptResponseView) {
						  leaf.view.setDisplayText(this.conversations.get(file.name));
						}
					  });
					return;
				}

				const file_cache = this.app.metadataCache.getFileCache(file);
				if (!file_cache){
					return;
				}
				let tags = getAllTags(file_cache);
				if (!tags){
					return;
				}
				this.settings.tags.every((tag) => {
						if (tags.includes('#'+tag)){
							this.getPromptText(tag).then((prompt) => {
							if (!prompt) {
								return true;
							}
							let starter_convo = [{ role: 'system', content: this.settings.chatgpt_behavior}];
							this.conversations.set(file.name, {last_updated: new Date().getTime(), conversations: starter_convo});
							this.addPlaceholdersToPrompt(prompt, file.name, file).then((prompt) => {
								this.conversations.get(file.name).conversations.push({ role: 'user', content: prompt});
								this.app.workspace.getLeavesOfType(VIEW_TYPE_CHATGPT_RESPONSE).forEach((leaf) => {
									if (leaf.view instanceof ChatGptResponseView) {
										//this is that later part I mentioned
									  leaf.view.setDisplayText(this.conversations.get(file.name));
									}
								  });
								//updates the parameter for the setDisplayText later
								this.callChatGPT(this.conversations.get(file.name)).then(() => {
									this.app.workspace.getLeavesOfType(VIEW_TYPE_CHATGPT_RESPONSE).forEach((leaf) => {
										if (leaf.view instanceof ChatGptResponseView) {
											//this is that later part I mentioned
										  leaf.view.setDisplayText(this.conversations.get(file.name));
										}
									  });

									  return true;
								});
							});

						});
					}
				});
			}
			
		}, ''));

		let date_today = new Date();
		let keysToRemove = [];
		for (let [key, value] of this.conversations) { 
			let diffTime = Math.abs(date_today.getTime() - value.last_updated);
			const diffDays = Math.ceil(diffTime / (1000 * 60 * 60 * 24)); 

			if (diffDays > this.settings.convo_retention) {
				keysToRemove.push(key);
			}
		}
		keysToRemove.forEach(element => {
			this.conversations.delete(element);
		});
	}

	async callChatGPT(dated_conversation : DatedConversation) {
		let cur_conversation = dated_conversation.conversations;
		if (this.settings.api_key == ''){
			new Notice('Please add an api key to the settings');
			return;
		  }

		  // Check if the user provided a prompt
			  try {
				const apiKey = this.settings.api_key;
				const apiUrl = 'https://api.openai.com/v1/chat/completions';
	  
				const response = await requestUrl({
					url: apiUrl,
					method: 'POST',
					contentType: 'application/json',
					headers: {
					  'Authorization': `Bearer ${apiKey}`,
					},
					body: JSON.stringify({
					  model: 'gpt-3.5-turbo',
					  messages: cur_conversation,
					}),
				  });
	  
				const modelReply = response.json.choices[0].message.content;
				cur_conversation.push({ role: 'assistant', content: modelReply});
				dated_conversation.last_updated = new Date().getTime();
				
			} catch (error) {
			  console.error('Error interacting with ChatGPT API:', error.message);
			  if (error.message.includes('429')){
			  	new Notice('Quota from ChatGPT has been exceeded. Either: \n 1. Too many requests per minute were sent. \n 2. You reached your monthly limit');
			  }
			}

	}

	async activateView() {
		const { workspace } = this.app;
		this.oldWorkspace = workspace;
	
		let leaf: WorkspaceLeaf | null = null;
		const leaves = workspace.getLeavesOfType(VIEW_TYPE_CHATGPT_RESPONSE);
	
		if (leaves.length > 0) {
		  // A leaf with our view already exists, use that
		  leaf = leaves[0];
		} else {
		  // Our view could not be found in the workspace, create a new leaf
		  // in the right sidebar for it
		  leaf = workspace.getRightLeaf(false);
		  await leaf.setViewState({ type: VIEW_TYPE_CHATGPT_RESPONSE, active: true });
		}
	
		// "Reveal" the leaf in case it is in a collapsed sidebar
		workspace.revealLeaf(leaf);
	  }

	async deactivateView() {
		const leaves = this.app.workspace.getLeavesOfType(VIEW_TYPE_CHATGPT_RESPONSE);
		if (leaves.length > 0) {
			// A leaf with our view already exists, use that
			let leaf = leaves[0];
			leaf.detach();
		}
	}



async getPromptText(tag: string) {
	const path = this.settings.path_to_prompt_template[this.settings.tags.indexOf(tag)];
	const tfile = this.app.metadataCache.getFirstLinkpathDest(path, path);
	if (!tfile) {
		console.error("Prompt template doesn't exist");
		return null;
	}
	return this.app.vault.cachedRead(tfile);
}

async addPlaceholdersToPrompt(prompt: string, filename: string, currentFile: TFile) {
	let promptText = prompt.replace("{{title}}", filename.substring(0, filename.length-3));

	if(promptText.contains("{{context}}")) {
		const full_file = await this.app.vault.cachedRead(currentFile)
		promptText = promptText.replace("{{context}}", full_file.substring(0, Math.min(full_file.length, this.max_context_length)));
		return promptText;
	}

	return promptText;

}

	async onunload() {
		this.settings.conversations = Object.fromEntries(this.conversations);
		await this.saveSettings();
	}

	async loadSettings() {
		this.settings = Object.assign({}, DEFAULT_SETTINGS, await this.loadData());
	}

	async saveSettings() {
		await this.saveData(this.settings);
	}
}

class SettingTab extends PluginSettingTab {
	plugin: PromptGptPlugin;

	constructor(app: App, plugin: PromptGptPlugin) {
		super(app, plugin);
		this.plugin = plugin;
	}

	display(): void {
		const {containerEl} = this;

		containerEl.empty();

		new Setting(containerEl)
			.setName("API key")
			.setDesc('Get your api key from: https://platform.openai.com/api-keys.')
			.addText(text => text
				.setPlaceholder('Enter api key')
				.setValue("****************")
				.onChange(async (value) => {
					//I don't think I can encrypt this api key properly?
					this.plugin.settings.api_key = value;
					await this.plugin.saveSettings();
				}));

		new Setting(containerEl)
			.setName("Tags to research")
			.setDesc('The tags you want ChatGPT to run on when note is opened.')
			.addText(text => text
				.setPlaceholder('tag1,tag2,tag3')
				.setValue(this.plugin.settings.tags.join(','))
				.onChange(async (value) => {
					this.plugin.settings.tags = value.split(',');
					await this.plugin.saveSettings();
				}));

		new Setting(containerEl)
			.setName("Prompt templates for each tag")
			.setDesc('The templates to use corresponding to the order of the tags above.')
			.addText(text => text
				.setPlaceholder('path1,path2,path3')
				.setValue(this.plugin.settings.path_to_prompt_template.join(','))
				.onChange(async (value) => {
					this.plugin.settings.path_to_prompt_template = value.split(',').map(m => normalizePath(m));
					await this.plugin.saveSettings();
				}));

		new Setting(containerEl)
				.setName("ChatGPT's behavior")
				.setDesc('How do you want it to act?')
				.addText(text => text
					.setPlaceholder('You are a helpful assistant.')
					.setValue(this.plugin.settings.chatgpt_behavior)
					.onChange(async (value) => {
						this.plugin.settings.chatgpt_behavior = value;
						await this.plugin.saveSettings();
					}));

		new Setting(containerEl)
				.setName("Conversation retention")
				.setDesc('How many days to hold conversations before deleting.')
				.addText(text => text
					.setPlaceholder("10")
					.setValue(String(this.plugin.settings.convo_retention))
					.onChange(async (value) => {
						this.plugin.settings.convo_retention = Math.min(Number(value), 30);
						await this.plugin.saveSettings();
					}));

	}
}