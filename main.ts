import {
	App,
	Editor,
	MarkdownView,
	Modal,
	Notice,
	Plugin,
	PluginSettingTab,
	Setting,
	TFile,
} from "obsidian";
import COS from 'cos-js-sdk-v5';

// Remember to rename these classes and interfaces!

interface ImgurPluginSettings {
	secretId: string;
	secretKey: string;
	bucket: string;
	region: string;
}

const DEFAULT_SETTINGS: ImgurPluginSettings = {
	secretId: "",
	secretKey: "",
	bucket: "",
	region: "ap-guangzhou"
};

export default class ImgurPlugin extends Plugin {
	settings: ImgurPluginSettings;
	private uploader: COSUploader;

	async onload() {
		await this.loadSettings();

		// 检查必要的配置是否已设置
		if (!this.settings.secretId || !this.settings.secretKey || !this.settings.bucket) {
			new Notice("请先在设置中配置腾讯云 COS 信息！");
			// 不初始化 uploader，等待用户配置
		} else {
			try {
				this.uploader = new COSUploader(this.settings);
				new Notice("腾讯云 COS 图床插件已启动！");
			} catch (error) {
				new Notice(`插件初始化失败：${error.message}`);
				console.error('Plugin initialization error:', error);
			}
		}

		// 拖拽图片上传处理
		this.registerEvent(
			this.app.workspace.on('editor-drop', async (evt: DragEvent, editor: Editor, markdownView: MarkdownView) => {
				evt.preventDefault();
				evt.stopPropagation();


				const files = evt.dataTransfer?.files;


				if (!files || files.length === 0) {

					return;
				}

				for (let i = 0; i < files.length; i++) {
					const file = files[i];


					if (!file.type.startsWith('image/')) {

						continue;
					}

					try {
						// 获取当前文件
						const activeFile = markdownView.file;
						if (!activeFile) {
							new Notice('未找到当前文件');
							continue;
						}

						// 上传到腾讯云
						const url = await this.uploader.uploadFile(file);

						// 插入新的远程图片链接
						const pos = editor.getCursor();
						editor.replaceRange(`![${file.name}](${url})`, pos);

						// 等待一小段时间确保本地图片已创建
						await new Promise(resolve => setTimeout(resolve, 100));

						// 获取当前文件内容并查找本地图片
						const content = await this.app.vault.read(activeFile);
						const imageRegex = /!\[\[(.*?)\]\]/g;
						const matches = [...content.matchAll(imageRegex)];

						// 删除最近创建的本地图片
						for (const match of matches) {
							const imagePath = match[1];
							const imageFile = this.app.vault.getAbstractFileByPath(imagePath);

							if (imageFile instanceof TFile) {
								await this.app.fileManager.trashFile(imageFile);


								// 替换文件内容中的本地图片链接
								const newContent = content.replace(`![[${imagePath}]]`, '');
								await this.app.vault.modify(activeFile, newContent);
							}
						}

						new Notice('图片上传成功！');
					} catch (error) {
						new Notice('图片上传失败：' + error.message);
						console.error('Upload error:', error);
					}
				}
			})
		);
		// 复制粘贴图片上传
		this.registerEvent(
			this.app.workspace.on('editor-paste', async (evt: ClipboardEvent, editor: Editor, markdownView: MarkdownView) => {
				const files = evt.clipboardData?.files;


				if (!files || files.length === 0) return;

				for (let i = 0; i < files.length; i++) {
					const file = files[i];
					if (!file.type.startsWith('image/')) continue;

					evt.preventDefault();

					try {
						// 获取当前文件
						const activeFile = markdownView.file;
						if (!activeFile) {
							new Notice('未找到当前文件');
							continue;
						}

						// 上传到腾讯云
						const url = await this.uploader.uploadFile(file);

						// 插入新的远程图片链接
						const pos = editor.getCursor();
						editor.replaceRange(`![${file.name}](${url})`, pos);

						// 等待一小段时间确保本地图片已创建
						await new Promise(resolve => setTimeout(resolve, 100));

						// 获取当前文件内容并查找本地图片
						const content = await this.app.vault.read(activeFile);
						const imageRegex = /!\[\[(.*?)\]\]/g;
						const matches = [...content.matchAll(imageRegex)];

						// 删除最近创建的本地图片
						for (const match of matches) {
							const imagePath = match[1];
							const imageFile = this.app.vault.getAbstractFileByPath(imagePath);

							if (imageFile instanceof TFile) {
								await this.app.fileManager.trashFile(imageFile);


								// 替换文件内容中的本地图片链接
								const newContent = content.replace(`![[${imagePath}]]`, '');
								await this.app.vault.modify(activeFile, newContent);
							}
						}

						new Notice('图片上传成功！');
					} catch (error) {
						new Notice('图片上传失败：' + error.message);
						console.error('Upload error:', error);
					}
				}
			})
		);
		// 笔记右键菜单上传处理
		this.registerEvent(
			this.app.workspace.on('file-menu', (menu, file: TFile) => {
				// 只对 Markdown 文件显示菜单
				if (file.extension !== 'md') return;

				menu.addItem((item) => {
					item
						.setTitle('上传图片到腾讯云COS')
						.setIcon('image-plus')
						.onClick(async () => {
							try {
								const content = await this.app.vault.read(file);

								// 匹配 Obsidian 格式的图片链接
								const imageRegex = /!\[\[([^\]]+)\]\]/g;
								const matches = [...content.matchAll(imageRegex)];

								if (matches.length === 0) {
									new Notice("未找到本地图片");
									return;
								}

								let newContent = content;
								for (const match of matches) {
									const imagePath = match[1];
									// 尝试不同的路径组合
									const possiblePaths = [
										imagePath,
										`images/${imagePath}`,
										...(file.parent ? [`${file.parent.path}/${imagePath}`, `${file.parent.path}/images/${imagePath}`] : [])
									];

									let imageFile: TFile | null = null;
									for (const path of possiblePaths) {
										const tempFile = this.app.vault.getAbstractFileByPath(path);
										if (tempFile instanceof TFile && tempFile.extension.match(/png|jpg|jpeg|gif|svg/i)) {
											imageFile = tempFile;
											break;
										}
									}

									if (!imageFile) {

										continue;
									}

									try {
										const imageArrayBuffer = await this.app.vault.readBinary(imageFile);
										const imageBlob = new Blob([imageArrayBuffer]);
										// 去除图片路径空白
										const imageToUpload = new File([imageBlob], imageFile.name.replace(/\s/g, ''), { type: 'image/png' });

										const url = await this.uploader.uploadFile(imageToUpload);

										// 替换当前图片链接
										newContent = newContent.replace(
											`![[${imagePath}]]`,
											`![${imageFile.name}](${url})`
										);

										// 删除本地图片文件
										await this.app.fileManager.trashFile(imageFile);
										new Notice(`图片 ${imageFile.name} 上传成功`);
									} catch (error) {
										new Notice(`图片 ${imagePath} 上传失败: ${error.message}`);
										console.error('Upload error:', error);
									}
								}

								// 一次性更新文件内容
								if (newContent !== content) {
									await this.app.vault.modify(file, newContent);
									new Notice("所有图片链接已更新");
								}
							} catch (error) {
								new Notice(`处理失败: ${error.message}`);
								console.error('Process error:', error);
							}
						});
				});
			})
		);

		// This adds a status bar item to the bottom of the app. Does not work on mobile apps.
		const statusBarItemEl = this.addStatusBarItem();
		statusBarItemEl.setText("Status Bar Text");

		// This adds a settings tab so the user can configure various aspects of the plugin
		this.addSettingTab(new ImgurSettingTab(this.app, this));

		// When registering intervals, this function will automatically clear the interval when the plugin is disabled.
		this.registerInterval(
			window.setInterval(() => { }, 5 * 60 * 1000)
		);
	}

	onunload() {
		new Notice("你的图床插件已卸载!");
	}

	async loadSettings() {
		this.settings = Object.assign(
			{},
			DEFAULT_SETTINGS,
			await this.loadData()
		);
	}

	async saveSettings() {
		await this.saveData(this.settings);
	}


}


class ImgurSettingTab extends PluginSettingTab {
	plugin: ImgurPlugin;

	constructor(app: App, plugin: ImgurPlugin) {
		super(app, plugin);
		this.plugin = plugin;
	}

	display(): void {
		const { containerEl } = this;
		containerEl.empty();

		containerEl.createEl('h2', { text: '腾讯云 COS 设置' });

		new Setting(containerEl)
			.setName("SecretId")
			.setDesc("腾讯云 API 密钥 SecretId")
			.addText((text) =>
				text
					.setPlaceholder("输入 SecretId")
					.setValue(this.plugin.settings.secretId)
					.onChange(async (value) => {
						this.plugin.settings.secretId = value.trim();
						await this.plugin.saveSettings();
					})
			);

		new Setting(containerEl)
			.setName("SecretKey")
			.setDesc("腾讯云 API 密钥 SecretKey")
			.addText((text) =>
				text
					.setPlaceholder("输入 SecretKey")
					.setValue(this.plugin.settings.secretKey)
					.onChange(async (value) => {
						this.plugin.settings.secretKey = value.trim();
						await this.plugin.saveSettings();
					})
			);

		new Setting(containerEl)
			.setName("Bucket")
			.setDesc("COS 存储桶名称")
			.addText((text) =>
				text
					.setPlaceholder("例如：my-bucket-1250000000")
					.setValue(this.plugin.settings.bucket)
					.onChange(async (value) => {
						this.plugin.settings.bucket = value.trim();
						await this.plugin.saveSettings();
					})
			);

		new Setting(containerEl)
			.setName("Region")
			.setDesc("存储桶所在地域")
			.addDropdown((dropdown) => {
				dropdown
					.addOption("ap-guangzhou", "广州")
					.addOption("ap-shanghai", "上海")
					.addOption("ap-beijing", "北京")
					.addOption("ap-chengdu", "成都")
					.addOption("ap-hongkong", "香港")
					.setValue(this.plugin.settings.region)
					.onChange(async (value) => {
						this.plugin.settings.region = value.trim();
						await this.plugin.saveSettings();
					});
			});
	}
}

class COSUploader {
	private cos: any;
	private settings: ImgurPluginSettings;

	constructor(settings: ImgurPluginSettings) {
		this.settings = settings;


		if (!settings.secretId || !settings.secretKey) {
			throw new Error("请先配置腾讯云 SecretId 和 SecretKey");
		}

		this.cos = new COS({
			SecretId: settings.secretId,
			SecretKey: settings.secretKey,
			Protocol: 'https:'
		});
	}

	async uploadFile(file: File): Promise<string> {
		if (!this.settings.bucket || !this.settings.region) {
			throw new Error("请先配置存储桶和地域信息");
		}

		// 修改文件名：将空格替换为短横线，并保持原始扩展名
		const originalName = file.name;
		const extension = originalName.split('.').pop();
		const nameWithoutExt = originalName.substring(0, originalName.lastIndexOf('.'));
		const processedName = nameWithoutExt.replace(/\s+/g, '-');
		const fileName = `${Date.now()}-${processedName}.${extension}`;

		return new Promise((resolve, reject) => {
			this.cos.putObject({
				Bucket: this.settings.bucket,
				Region: this.settings.region,
				Key: fileName,
				Body: file,
			}, (err: any, data: any) => {
				if (err) {
					console.error("上传错误:", err);
					reject(err);
					return;
				}

				const url = `https://${this.settings.bucket}.cos.${this.settings.region}.myqcloud.com/${fileName}`;
				resolve(url);
			});
		});
	}
}
