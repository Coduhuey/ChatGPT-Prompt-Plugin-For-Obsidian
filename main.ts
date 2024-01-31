import { workerData } from 'worker_threads';
import { ExampleView } from './main';
import { TFile, ViewState, Workspace, ItemView, addIcon, Menu, App, Editor, MarkdownView, Modal, Notice, Plugin, PluginSettingTab, Setting, WorkspaceLeaf, Vault, getAllTags } from 'obsidian';

// Remember to rename these classes and interfaces!

interface MyPluginSettings {
	api_key: string;
	tags: string[];
	path_to_prompt_template: string[];
	chatgpt_behavior: string;
	convo_retention: number;
	conversations: Object;
	last_convo: DatedConversation;
}

const DEFAULT_SETTINGS: MyPluginSettings = {
	api_key: '',
	tags: [],
	path_to_prompt_template: [],
	chatgpt_behavior: 'You are a helpful assistant.',
	convo_retention: 10,
	conversations: {},
	last_convo: {conversations: [{role: "system", content: "You are a helpful assistant"}], last_updated: new Date()},
}

const axios = require('axios');

class Conversation{
	role: string;
	content: string;
}

class DatedConversation{
	conversations: Conversation[];
	last_updated: Date;
}

export const VIEW_TYPE_EXAMPLE = "example-view";


export class ExampleView extends ItemView {
	display_text: string;
	conversation: DatedConversation;
	leaf: WorkspaceLeaf;
	plugin: HelloWorldPlugin;
  constructor(leaf: WorkspaceLeaf, plugin : HelloWorldPlugin) {
    super(leaf);
	
	this.plugin = plugin;
  }

  getViewType() {
    return VIEW_TYPE_EXAMPLE;
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
    let containerEl = container.createEl("div", { text: "ChatGPT" });
	this.createChatUI(containerEl);
  }

  async onClose() {
	this.plugin.setLastConvo(this.conversation);
  }

  createChatUI(container: HTMLElement) {

	container.style.height = '100%';
	container.style.width = '100%';

	const linebreak = container.createEl('div');
	linebreak.style.padding = '5px';
	//linebreak.style.borderTop = '1px solid #ccc';
	//linebreak.style.borderBottom = '1px solid #ccc';
	container.appendChild(linebreak);

	const chatDiv = container.createEl('div');
	chatDiv.id = 'chat-container';
	chatDiv.style.height = '92%';
	chatDiv.style.overflow = 'auto';
	chatDiv.style.userSelect = "text";
	//chatDiv.style.display = 'flex';
	//chatDiv.style.flexDirection = 'column-reverse';
	//chatDiv.style.border = '1px solid #ccc';
	chatDiv.style.padding = '10px';
  
	container.appendChild(chatDiv);
  
	const inputBox = document.createElement('input');
	inputBox.type = 'text';
	inputBox.placeholder = 'Type your message...';
	inputBox.style.width = '100%';
	inputBox.style.marginTop = '10px';

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

	//should make this a nice border, a block for each text between user and assistant
	chatDiv.innerHTML = this.conversation.conversations
	.map((msg) => `<div><strong>${this.capitalizeFirstLetter(msg.role)}:\n\n</strong> ${this.formatContent(msg.content)}</div>`)
	  .join('');

	  chatDiv.scrollTop = chatDiv.scrollHeight;
  }

  capitalizeFirstLetter(s : string) {
    return s.charAt(0).toUpperCase() + s.slice(1);
}

formatContent(content: string) {
    // Split content into lines
    const lines = content.split('\n');

    // Convert lines into a structured list
    const listItems = lines.map((line) => `${line}<br>`).join('');

    // Wrap the list items in an unordered list
    return `<ul>${listItems}</ul>`;
}
} 

export default class HelloWorldPlugin extends Plugin {
	settings: MyPluginSettings;
	window: WorkspaceLeaf;
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


		//this.settings.conversations = new Map<string, Conversation[]>();

		//this.conversations = this.settings.conversations;
		//console.log(typeof this.conversations);
		//this.conversations = new Map<string, DatedConversation>();

		this.conversations = new Map(Object.entries(this.settings.conversations));


		// This adds a settings tab so the user can configure various aspects of the plugin
		this.addSettingTab(new SampleSettingTab(this.app, this));

		this.addRibbonIcon('dice', 'Show/Hide ChatGPT', () => {
			const leaves = this.app.workspace.getLeavesOfType(VIEW_TYPE_EXAMPLE);

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
			VIEW_TYPE_EXAMPLE,
			(leaf) => new ExampleView(leaf, this)
		  );

		//stops a console log error message, probably due to a race condition
		//this.activateView();


		this.app.workspace.on('file-open', (file) => {
			if(!this.loaded){
				return;
			}
			if (file){
				if(file.name.substring(file.name.length - 3) !== '.md'){
					return;
				}

				if(this.conversations.has(file.name)){
					this.app.workspace.getLeavesOfType(VIEW_TYPE_EXAMPLE).forEach((leaf) => {
						if (leaf.view instanceof ExampleView) {
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
				this.settings.tags.forEach((tag) => {
						if (tags.includes('#'+tag)){
							this.getPromptText(tag).then((prompt) => {
							if (!prompt) {
								return;
							}
							var starter_convo = [{ role: 'system', content: this.settings.chatgpt_behavior}];
							this.conversations.set(file.name, {last_updated: new Date(), conversations: starter_convo});
							this.addPlaceholdersToPrompt(prompt, file.name, file).then((prompt) => {
								this.conversations.get(file.name).conversations.push({ role: 'user', content: prompt});
								this.app.workspace.getLeavesOfType(VIEW_TYPE_EXAMPLE).forEach((leaf) => {
									if (leaf.view instanceof ExampleView) {
										//this is that later part I mentioned
									  leaf.view.setDisplayText(this.conversations.get(file.name));
									}
								  });
								//updates the parameter for the setDisplayText later
								this.callChatGPT(this.conversations.get(file.name)).then(() => {
									this.app.workspace.getLeavesOfType(VIEW_TYPE_EXAMPLE).forEach((leaf) => {
										if (leaf.view instanceof ExampleView) {
											//this is that later part I mentioned
										  leaf.view.setDisplayText(this.conversations.get(file.name));
										}
									  });

									  return;
								});
							});

						});
					}
				});
			}
			
		}, '');

		var date_today = new Date();
		var keysToRemove = [];
		for (let [key, value] of this.conversations) { 
			let diffTime = Math.abs(date_today - value.last_updated);
			const diffDays = Math.ceil(diffTime / (1000 * 60 * 60 * 24)); 

			if (diffDays > this.settings.convo_retention) {
				keysToRemove.push(key);
			}
		}
		keysToRemove.forEach(element => {
			this.conversations.delete(element);
		});
	}

	async callChatGPT(dated_conversation : DatedConversation) { //: Promise<string>
		let cur_conversation = dated_conversation.conversations;
		if (this.settings.api_key == ''){
			new Notice('Please add an api key to the settings');
			return;
		  }

		  // Check if the user provided a prompt
			  try {
				const apiKey = this.settings.api_key;
				const apiUrl = 'https://api.openai.com/v1/chat/completions';
	  
				const response = await axios.post(
				  apiUrl,
				  {
					model: 'gpt-3.5-turbo',
					messages: cur_conversation,
				  },
				  {
					headers: {
					  'Content-Type': 'application/json',
					  'Authorization': `Bearer ${apiKey}`,
					},
				  }
				);
	  
				const modelReply = response.data.choices[0].message.content;
				cur_conversation.push({ role: 'assistant', content: modelReply});
				dated_conversation.last_updated = new Date();
				
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
		const leaves = workspace.getLeavesOfType(VIEW_TYPE_EXAMPLE);
	
		if (leaves.length > 0) {
		  // A leaf with our view already exists, use that
		  leaf = leaves[0];
		} else {
		  // Our view could not be found in the workspace, create a new leaf
		  // in the right sidebar for it
		  leaf = workspace.getRightLeaf(false);
		  await leaf.setViewState({ type: VIEW_TYPE_EXAMPLE, active: true });
		}
	
		// "Reveal" the leaf in case it is in a collapsed sidebar
		workspace.revealLeaf(leaf);
	  }

	async deactivateView() {
		const leaves = this.app.workspace.getLeavesOfType(VIEW_TYPE_EXAMPLE);
		if (leaves.length > 0) {
			// A leaf with our view already exists, use that
			var leaf = leaves[0];
			leaf.detach();
			//var rightLeaf = this.app.workspace.getRightLeaf(false);
			//this.app.workspace.changeLayout(this.oldWorkspace);
			//await leaf.setViewState({ type: VIEW_TYPE_EXAMPLE, active: false });
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
		//this.window.detach();

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

class SampleSettingTab extends PluginSettingTab {
	plugin: HelloWorldPlugin;

	constructor(app: App, plugin: HelloWorldPlugin) {
		super(app, plugin);
		this.plugin = plugin;
	}

	display(): void {
		const {containerEl} = this;

		containerEl.empty();

		new Setting(containerEl)
			.setName("API key")
			.setDesc('Get your api key from: https://platform.openai.com/api-keys')
			.addText(text => text
				.setPlaceholder('Enter api key')
				.setValue(this.plugin.settings.api_key)
				.onChange(async (value) => {
					this.plugin.settings.api_key = value;
					await this.plugin.saveSettings();
				}));

		new Setting(containerEl)
			.setName("Tags to research")
			.setDesc('The tags you want chatgpt to run on when note is opened')
			.addText(text => text
				.setPlaceholder('tag1,tag2,tag3')
				.setValue(this.plugin.settings.tags.join(','))
				.onChange(async (value) => {
					this.plugin.settings.tags = value.split(',');
					await this.plugin.saveSettings();
				}));

		new Setting(containerEl)
			.setName("Prompt templates for each tag")
			.setDesc('The templates to use corresponding to the order of the tags above')
			.addText(text => text
				.setPlaceholder('path1,path2,path3')
				.setValue(this.plugin.settings.path_to_prompt_template.join(','))
				.onChange(async (value) => {
					this.plugin.settings.path_to_prompt_template = value.split(',');
					await this.plugin.saveSettings();
				}));

		new Setting(containerEl)
				.setName("ChatGPT's Behavior")
				.setDesc('How do you want it to act?')
				.addText(text => text
					.setPlaceholder('You are a helpful assistant.')
					.setValue(this.plugin.settings.chatgpt_behavior)
					.onChange(async (value) => {
						this.plugin.settings.chatgpt_behavior = value;
						await this.plugin.saveSettings();
					}));

		new Setting(containerEl)
				.setName("Conversation Retention")
				.setDesc('How many days to hold conversations before deleting')
				.addText(text => text
					.setPlaceholder("10")
					.setValue(String(this.plugin.settings.convo_retention))
					.onChange(async (value) => {
						this.plugin.settings.convo_retention = Math.min(Number(value), 30);
						await this.plugin.saveSettings();
					}));

	}
}
