import COS from "cos-js-sdk-v5";
import {
	App,
	Editor,
	MarkdownView,
	Notice,
	Plugin,
	PluginSettingTab,
	Setting,
	TFile,
} from "obsidian";

interface ImgurPluginSettings {
	secretId: string;
	secretKey: string;
	bucket: string;
	region: string;
	prefix: string;
}

const DEFAULT_SETTINGS: ImgurPluginSettings = {
	secretId: "",
	secretKey: "",
	bucket: "",
	region: "",
	prefix: "",
};

export default class ImgurPlugin extends Plugin {
	settings: ImgurPluginSettings;
	private uploader: COSUploader;

	async onload() {
		await this.loadSettings();

		// 初始化上传器的函数
		const initUploader = () => {
			// 检查所有必要的配置是否都已设置
			if (
				this.settings.secretId &&
				this.settings.secretKey &&
				this.settings.bucket &&
				this.settings.region
			) {
				try {
					this.uploader = new COSUploader(this.settings);
					new Notice("腾讯云 COS 配置已更新！");
				} catch (error) {
					new Notice(`插件初始化失败：${error.message}`);
					console.error("Plugin initialization error:", error);
				}
			}
		};

		// 初始检查
		if (
			!this.settings.secretId ||
			!this.settings.secretKey ||
			!this.settings.bucket ||
			!this.settings.region
		) {
			new Notice("请先在设置中配置腾讯云 COS 信息！");
		} else {
			initUploader();
		}

		// 拖拽图片上传处理
		this.registerEvent(
			this.app.workspace.on(
				"editor-drop",
				async (
					evt: DragEvent,
					editor: Editor,
					markdownView: MarkdownView
				) => {
					evt.preventDefault();
					evt.stopPropagation();

					const files = evt.dataTransfer?.files;

					if (!files || files.length === 0) {
						return;
					}

					for (let i = 0; i < files.length; i++) {
						const file = files[i];

						try {
							// 获取当前文件
							const activeFile = markdownView.file;
							if (!activeFile) {
								new Notice("未找到当前文件");
								continue;
							}

							// 上传到腾讯云
							const url = await this.uploader.uploadFile(file);

							// 插入新的远程图片链接
							const pos = editor.getCursor();
							editor.replaceRange(`![${file.name}](${url})`, pos);

							// 等待一小段时间确保本地图片已创建
							await new Promise((resolve) =>
								setTimeout(resolve, 100)
							);

							// 获取当前文件内容并查找本地图片
							const content = await this.app.vault.read(
								activeFile
							);
							const imageRegex = /!\[\[(.*?)\]\]/g;
							const matches = [...content.matchAll(imageRegex)];

							// 删除最近创建的本地图片
							for (const match of matches) {
								const imagePath = match[1];
								const imageFile = this.findImageFile(
									imagePath,
									activeFile
								);

								if (imageFile instanceof TFile) {
									await this.app.fileManager.trashFile(
										imageFile
									);

									// 替换文件内容中的本地图片链接
									const newContent = content.replace(
										`![[${imagePath}]]`,
										""
									);
									await this.app.vault.modify(
										activeFile,
										newContent
									);
								}
							}

							new Notice("图片上传成功！");
						} catch (error) {
							new Notice("图片上传失败：" + error.message);
							console.error("Upload error:", error);
						}
					}
				}
			)
		);
		// 复制粘贴图片上传
		this.registerEvent(
			this.app.workspace.on(
				"editor-paste",
				async (
					evt: ClipboardEvent,
					editor: Editor,
					markdownView: MarkdownView
				) => {
					const files = evt.clipboardData?.files;

					if (!files || files.length === 0) return;

					for (let i = 0; i < files.length; i++) {
						const file = files[i];
						evt.preventDefault();

						try {
							// 获取当前文件
							const activeFile = markdownView.file;
							if (!activeFile) {
								new Notice("未找到当前文件");
								continue;
							}

							// 上传到腾讯云
							const url = await this.uploader.uploadFile(file);

							// 插入新的远程图片链接
							const pos = editor.getCursor();
							editor.replaceRange(`![${file.name}](${url})`, pos);

							// 等待一小段时间确保本地图片已创建
							await new Promise((resolve) =>
								setTimeout(resolve, 100)
							);

							// 获取当前文件内容并查找本地图片
							await this.app.vault.process(
								activeFile,
								(content) => {
									const imageRegex = /!\[\[(.*?)\]\]/g;
									const matches = [
										...content.matchAll(imageRegex),
									];

									// 删除最近创建的本地图片
									for (const match of matches) {
										const imagePath = match[1];
										const imageFile = this.findImageFile(
											imagePath,
											activeFile
										);

										if (imageFile instanceof TFile) {
											this.app.fileManager.trashFile(
												imageFile
											);

											// 替换文件内容中的本地图片链接
											content = content.replace(
												`![[${imagePath}]]`,
												""
											);
										}
									}

									return content;
								}
							);

							new Notice("图片上传成功！");
						} catch (error) {
							new Notice("图片上传失败：" + error.message);
							console.error("Upload error:", error);
						}
					}
				}
			)
		);
		// 笔记右键菜单上传处理
		this.registerEvent(
			this.app.workspace.on("file-menu", (menu, file: TFile) => {
				// 只对 Markdown 文件显示菜单
				if (file.extension !== "md") return;

				menu.addItem((item) => {
					item.setTitle("上传图片到腾讯云COS")
						.setIcon("image-plus")
						.onClick(async () => {
							try {
								const content = await this.app.vault.read(file);

								// 匹配 Obsidian 格式的图片链接
								const imageRegex = /!\[\[([^\]]+)\]\]/g;
								const matches = [
									...content.matchAll(imageRegex),
								];

								if (matches.length === 0) {
									new Notice("未找到本地图片");
									return;
								}

								let newContent = content;
								for (const match of matches) {
									const imagePath = match[1];

									// 获取图片文件
									const imageFile = this.findImageFile(
										imagePath,
										file
									);

									if (!imageFile) {
										console.log(`未找到图片: ${imagePath}`);
										continue;
									}

									try {
										const imageArrayBuffer =
											await this.app.vault.readBinary(
												imageFile
											);
										const imageBlob = new Blob([
											imageArrayBuffer,
										]);
										const imageToUpload = new File(
											[imageBlob],
											imageFile.name.replace(/\s/g, ""),
											{
												type: "image/png",
											}
										);

										const url =
											await this.uploader.uploadFile(
												imageToUpload
											);

										// 替换当前图片链接
										newContent = newContent.replace(
											`![[${imagePath}]]`,
											`![${imageFile.name}](${url})`
										);

										// 删除本地图片文件
										await this.app.fileManager.trashFile(
											imageFile
										);
										new Notice(
											`图片 ${imageFile.name} 上传成功`
										);
									} catch (error) {
										new Notice(
											`图片 ${imagePath} 上传失败: ${error.message}`
										);
										console.error("Upload error:", error);
									}
								}

								// 一次性更新文件内容
								if (newContent !== content) {
									await this.app.vault.modify(
										file,
										newContent
									);
									new Notice("所有图片链接已更新");
								}
							} catch (error) {
								new Notice(`处理失败: ${error.message}`);
								console.error("Process error:", error);
							}
						});
				});
			})
		);

		// This adds a settings tab so the user can configure various aspects of the plugin
		this.addSettingTab(new ImgurSettingTab(this.app, this, initUploader));

		// When registering intervals, this function will automatically clear the interval when the plugin is disabled.
		this.registerInterval(window.setInterval(() => {}, 5 * 60 * 1000));
	}

	onunload() {
		if (this.uploader) {
			this.uploader.cleanup();
		}
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

	// 添加新的辅助方法来查找图片文件
	private findImageFile(imagePath: string, currentFile: TFile): TFile | null {
		// 1. 尝试直接获取（绝对路径）
		let imageFile = this.app.vault.getAbstractFileByPath(imagePath);
		if (imageFile instanceof TFile && this.isImageFile(imageFile)) {
			return imageFile;
		}

		// 2. 尝试在当前笔记所在文件夹中查找
		if (currentFile.parent) {
			const relativePath = `${currentFile.parent.path}/${imagePath}`;
			imageFile = this.app.vault.getAbstractFileByPath(relativePath);
			if (imageFile instanceof TFile && this.isImageFile(imageFile)) {
				return imageFile;
			}
		}

		// 3. 在vault根目录查找
		imageFile = this.app.vault.getAbstractFileByPath(`/${imagePath}`);
		if (imageFile instanceof TFile && this.isImageFile(imageFile)) {
			return imageFile;
		}

		// 4. 递归搜索整个vault
		const files = this.app.vault.getFiles();
		return (
			files.find(
				(file) => file.name === imagePath && this.isImageFile(file)
			) || null
		);
	}

	// 添加辅助方法来检查文件是否为图片
	private isImageFile(file: TFile): boolean {
		return (
			file.extension.toLowerCase().match(/png|jpg|jpeg|gif|svg|webp/i) !==
			null
		);
	}
}

class ImgurSettingTab extends PluginSettingTab {
	plugin: ImgurPlugin;
	private initUploader: () => void;

	constructor(app: App, plugin: ImgurPlugin, initUploader: () => void) {
		super(app, plugin);
		this.plugin = plugin;
		this.initUploader = initUploader;
	}

	display(): void {
		const { containerEl } = this;
		containerEl.empty();

		// 创建一个防抖函数来延迟初始化
		const debouncedInit = this.debounce(() => {
			this.initUploader();
		}, 2000); // 2秒延迟

		new Setting(containerEl)
			.setName("Secret Id")
			.setDesc("腾讯云 API 密钥 Secret Id")
			.addText((text) =>
				text
					.setPlaceholder("输入 Secret Id")
					.setValue(this.plugin.settings.secretId)
					.onChange(async (value) => {
						this.plugin.settings.secretId = value.trim();
						await this.plugin.saveSettings();
						debouncedInit();
					})
			);

		new Setting(containerEl)
			.setName("Secret Key")
			.setDesc("腾讯云 API 密钥 Secret Key")
			.addText((text) =>
				text
					.setPlaceholder("输入 Secret Key")
					.setValue(this.plugin.settings.secretKey)
					.onChange(async (value) => {
						this.plugin.settings.secretKey = value.trim();
						await this.plugin.saveSettings();
						debouncedInit();
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
						debouncedInit();
					})
			);

		new Setting(containerEl)
			.setName("Region")
			.setDesc("存储桶所在地域")
			.addDropdown((dropdown) => {
				dropdown
					.addOption("ap-guangzhou", "广州")
					.addOption("ap-beijing", "北京")
					.addOption("ap-shanghai", "上海")
					.addOption("ap-chengdu", "成都")
					.addOption("ap-hongkong", "香港")
					.addOption("ap-singapore", "南京")
					.addOption("ap-chongqing", "重庆")
					.setValue(this.plugin.settings.region)
					.onChange(async (value) => {
						this.plugin.settings.region = value.trim();
						await this.plugin.saveSettings();
					});
			});

		new Setting(containerEl)
			.setName("存储路径前缀")
			.setDesc("设置文件在 COS 中的存储路径前缀，例如：images")
			.addText((text) =>
				text
					.setPlaceholder("例如：images")
					.setValue(this.plugin.settings.prefix)
					.onChange(async (value) => {
						// 确保前缀格式正确（去除首尾斜杠）
						let prefix = value.trim();
						prefix = prefix.replace(/^\/+|\/+$/g, "");
						this.plugin.settings.prefix = prefix;
						await this.plugin.saveSettings();
					})
			);
	}

	// 添加防抖函数
	private debounce(func: Function, wait: number) {
		let timeout: NodeJS.Timeout;
		return function executedFunction(...args: any[]) {
			const later = () => {
				clearTimeout(timeout);
				func(...args);
			};
			clearTimeout(timeout);
			timeout = setTimeout(later, wait);
		};
	}
}

class COSUploader {
	private cos: any;
	private settings: ImgurPluginSettings;
	private urlCache: Map<string, string>;
	private updating: boolean = false;
	private updateInterval: NodeJS.Timeout | null = null;

	constructor(settings: ImgurPluginSettings) {
		this.settings = settings;
		this.urlCache = new Map();

		if (!settings.secretId || !settings.secretKey) {
			throw new Error("请先配置腾讯云 SecretId 和 SecretKey");
		}

		this.cos = new COS({
			SecretId: settings.secretId,
			SecretKey: settings.secretKey,
			Protocol: "https:",
		});

		// 启动定时更新
		this.startUrlUpdateInterval();
	}

	private async updateAllPresignedUrls() {
		// 防止重复更新
		if (this.updating) {
			console.log("正在更新中，跳过本次更新");
			return;
		}

		this.updating = true;
		console.log("检查预签名URL是否需要更新");
		console.log("当前缓存的文件数:", this.urlCache.size);

		try {
			const promises = Array.from(this.urlCache.keys()).map(
				async (key) => {
					try {
						// 从URL中提取过期时间
						const currentUrl = this.urlCache.get(key);
						if (!currentUrl) return;

						const urlObj = new URL(currentUrl);
						const signTime = urlObj.searchParams.get("q-sign-time");
						if (!signTime) return;

						const [_, expireTime] = signTime.split(";").map(Number);
						const now = Math.floor(Date.now() / 1000);
						const oneDayInSeconds = 24 * 60 * 60;

						// 只有当URL将在24小时内过期时才更新
						if (expireTime - now <= oneDayInSeconds) {
							console.log(`文件 ${key} 的URL即将过期，正在更新`);
							const newUrl = await this.getSignedUrl(
								key,
								30 * 24 * 60 * 60
							);
							this.urlCache.set(key, newUrl);
							console.log(`文件 ${key} 的URL更新成功`);
						} else {
							console.log(`文件 ${key} 的URL仍然有效，无需更新`);
						}
					} catch (error) {
						console.error(
							`检查/更新预签名URL失败 (${key}):`,
							error
						);
					}
				}
			);

			await Promise.all(promises);
		} finally {
			this.updating = false;
			console.log("URL检查/更新完成");
		}
	}

	private startUrlUpdateInterval() {
		console.log("启动定时检查");
		// 每天检查一次是否需要更新
		this.updateInterval = setInterval(() => {
			this.updateAllPresignedUrls();
		}, 24 * 60 * 60 * 1000); // 24小时的毫秒数
	}

	// 在插件卸载时清理定时器
	public cleanup() {
		if (this.updateInterval) {
			clearInterval(this.updateInterval);
			this.updateInterval = null;
		}
	}

	async uploadFile(file: File): Promise<string> {
		if (!this.settings.bucket || !this.settings.region) {
			throw new Error("请先配置存储桶和地域信息");
		}

		// 修改文件名：将空格替换为短横线，并保持原始扩展名
		const originalName = file.name;
		const extension = originalName.split(".").pop();
		const nameWithoutExt = originalName.substring(
			0,
			originalName.lastIndexOf(".")
		);
		const processedName = nameWithoutExt.replace(/\s+/g, "-");
		const fileName = `${Date.now()}-${processedName}.${extension}`;

		// 构建完整的文件路径
		const prefix = this.settings.prefix ? `${this.settings.prefix}/` : "";
		const fullPath = `${prefix}${fileName}`;

		return new Promise((resolve, reject) => {
			this.cos.putObject(
				{
					Bucket: this.settings.bucket,
					Region: this.settings.region,
					Key: fullPath,
					Body: file,
				},
				async (err: any, data: any) => {
					if (err) {
						console.error("上传错误:", err);
						reject(err);
						return;
					}

					try {
						// 生成带签名的临时访问URL，有效期为30天
						const url = await this.getSignedUrl(
							fullPath,
							30 * 24 * 60 * 60
						);
						this.urlCache.set(fullPath, url);
						resolve(url);
					} catch (error) {
						reject(error);
					}
				}
			);
		});
	}

	private getSignedUrl(
		fileName: string,
		expires: number = 30 * 24 * 60 * 60 // 默认30天
	): Promise<string> {
		return new Promise((resolve, reject) => {
			this.cos.getObjectUrl(
				{
					Bucket: this.settings.bucket,
					Region: this.settings.region,
					Key: fileName,
					Sign: true,
					Expires: expires,
				},
				(err: any, data: any) => {
					if (err) {
						reject(err);
						return;
					}
					resolve(
						data.Url +
							(data.Url.indexOf("?") > -1 ? "&" : "?") +
							"response-content-disposition=inline"
					);
				}
			);
		});
	}
}
