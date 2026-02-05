import COS from "cos-js-sdk-v5";
import {
	App,
	ButtonComponent,
	Editor,
	MarkdownView,
	Modal,
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
	expiration: number;
	backupPath: string;
}

const DEFAULT_SETTINGS: ImgurPluginSettings = {
	secretId: "",
	secretKey: "",
	bucket: "",
	region: "",
	prefix: "",
	expiration: 12 * 30 * 24 * 60 * 60,
	backupPath: "",
};

export default class ImgurPlugin extends Plugin {
	settings: ImgurPluginSettings;
	public uploader: COSUploader;

	async onload() {
		await this.loadSettings();

		let isFirstInitialization =
			!this.settings.secretId ||
			!this.settings.secretKey ||
			!this.settings.bucket ||
			!this.settings.region;

		const initUploader = () => {
			if (
				this.settings.secretId &&
				this.settings.secretKey &&
				this.settings.bucket &&
				this.settings.region
			) {
				try {
					this.uploader = new COSUploader(this.settings);
					if (isFirstInitialization) {
						new Notice("腾讯云 COS 配置已完成！");
						isFirstInitialization = false;
					}
				} catch (error) {
					new Notice(`插件初始化失败：${error.message}`);
					console.error("Plugin initialization error:", error);
				}
			}
		};

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

		// 注册图片大小调整功能
		this.registerImageResizer();

		this.registerEvent(
			this.app.workspace.on(
				"editor-drop",
				async (
					evt: DragEvent,
					editor: Editor,
					markdownView: MarkdownView,
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
							const activeFile = markdownView.file;
							if (!activeFile) {
								new Notice("未找到当前文件");
								continue;
							}

							// 先备份原始图片（在上传之前）
							const backupImageName = await this.backupImage(
								file,
								activeFile,
								"拖拽图片",
							);

							// 上传图片
							const url = await this.uploader.uploadFile(file);

							const pos = editor.getCursor();
							editor.replaceRange(`![${file.name}](${url})`, pos);

							await new Promise((resolve) =>
								setTimeout(resolve, 100),
							);

							const content =
								await this.app.vault.read(activeFile);
							const imageRegex =
								/!(?:\[\[([^\]]+)\]\]|\[.*?\]\(([^)]+)\))/g;
							const matches = [...content.matchAll(imageRegex)];

							for (const match of matches) {
								const imagePath = match[1] || match[2];
								const imageFile = this.findImageFile(
									imagePath,
									activeFile,
								);

								if (imageFile instanceof TFile) {
									await this.app.fileManager.trashFile(
										imageFile,
									);

									const newContent = content.replace(
										`![[${imagePath}]]`,
										"",
									);
									await this.app.vault.modify(
										activeFile,
										newContent,
									);
								}
							}

							new Notice("图片上传成功！");

							// 备份包含新图片的笔记内容
							await this.backupNote(activeFile, backupImageName);
						} catch (error) {
							new Notice("图片上传失败：" + error.message);
							console.error("Upload error:", error);
						}
					}
				},
			),
		);

		this.registerEvent(
			this.app.workspace.on(
				"editor-paste",
				async (
					evt: ClipboardEvent,
					editor: Editor,
					markdownView: MarkdownView,
				) => {
					const files = evt.clipboardData?.files;

					if (!files || files.length === 0) return;

					for (let i = 0; i < files.length; i++) {
						const file = files[i];
						evt.preventDefault();

						try {
							const activeFile = markdownView.file;
							if (!activeFile) {
								new Notice("未找到当前文件");
								continue;
							}

							// 先备份原始图片（在上传之前）
							const backupImageName = await this.backupImage(
								file,
								activeFile,
								"粘贴图片",
							);

							// 上传图片
							const url = await this.uploader.uploadFile(file);

							const pos = editor.getCursor();
							editor.replaceRange(`![${file.name}](${url})`, pos);

							await new Promise((resolve) =>
								setTimeout(resolve, 100),
							);

							await this.app.vault.process(
								activeFile,
								(content) => {
									const imageRegex =
										/!(?:\[\[([^\]]+)\]\]|\[.*?\]\(([^)]+)\))/g;
									const matches = [
										...content.matchAll(imageRegex),
									];

									for (const match of matches) {
										const imagePath = match[1] || match[2];
										const imageFile = this.findImageFile(
											imagePath,
											activeFile,
										);

										if (imageFile instanceof TFile) {
											this.app.fileManager.trashFile(
												imageFile,
											);

											content = content.replace(
												`![[${imagePath}]]`,
												"",
											);
										}
									}

									return content;
								},
							);

							new Notice("图片上传成功！");

							// 备份包含新图片的笔记内容
							await this.backupNote(activeFile, backupImageName);
						} catch (error) {
							new Notice("图片上传失败：" + error.message);
							console.error("Upload error:", error);
						}
					}
				},
			),
		);

		this.registerEvent(
			this.app.workspace.on("file-menu", (menu, file: TFile) => {
				if (file.extension !== "md") return;

				menu.addItem((item) => {
					item.setTitle("上传图片到腾讯云COS")
						.setIcon("image-plus")
						.onClick(async () => {
							try {
								const content = await this.app.vault.read(file);

								const imageRegex =
									/!(?:\[\[([^\]]+)\]\]|\[.*?\]\(([^)]+)\))/g;
								const matches = [
									...content.matchAll(imageRegex),
								];

								console.log(
									`找到 ${matches.length} 个图片链接:`,
									matches.map((m) => m[0]),
								);

								if (matches.length === 0) {
									new Notice("未找到本地图片");
									return;
								}

								// 先创建备份文件夹和笔记子文件夹
								// 如果设置了自定义备份路径，使用自定义路径；否则使用默认路径
								let backupFolderPath: string;
								if (this.settings.backupPath) {
									// 确保自定义路径格式正确
									backupFolderPath =
										this.settings.backupPath.startsWith("/")
											? this.settings.backupPath.substring(
													1,
												)
											: this.settings.backupPath;
								} else {
									backupFolderPath = `${file.parent?.path || ""}/备份`;
								}

								let backupFolder =
									this.app.vault.getAbstractFileByPath(
										backupFolderPath,
									);
								if (!backupFolder) {
									try {
										backupFolder =
											await this.app.vault.createFolder(
												backupFolderPath,
											);
									} catch (error) {
										new Notice(
											`创建备份文件夹失败: ${error.message}`,
										);
										return;
									}
								}

								// 备份原始笔记内容（只备份一次）
								const noteBackupFolderPath = `${backupFolderPath}/${file.basename}`;
								let noteBackupFolder =
									this.app.vault.getAbstractFileByPath(
										noteBackupFolderPath,
									);
								if (!noteBackupFolder) {
									try {
										noteBackupFolder =
											await this.app.vault.createFolder(
												noteBackupFolderPath,
											);
									} catch (error) {
										new Notice(
											`创建笔记备份文件夹失败: ${error.message}`,
										);
										return;
									}
								}

								const backupFileName = `${file.basename}-backup.md`;
								const backupFilePath = `${noteBackupFolderPath}/${backupFileName}`;

								// 检查备份文件是否已存在
								const existingBackup =
									this.app.vault.getAbstractFileByPath(
										backupFilePath,
									);
								if (!existingBackup) {
									await this.app.vault.create(
										backupFilePath,
										content,
									);
									new Notice(`已备份笔记: ${backupFileName}`);
								}

								let newContent = content;
								for (const match of matches) {
									const imagePath = match[1] || match[2];
									console.log(`处理图片路径: ${imagePath}`);

									const imageFile = this.findImageFile(
										imagePath,
										file,
									);

									console.log(`找到的图片文件:`, imageFile);

									if (!imageFile) {
										console.log(
											`跳过图片: ${imagePath} (文件不存在)`,
										);
										continue;
									}

									try {
										const imageArrayBuffer =
											await this.app.vault.readBinary(
												imageFile,
											);
										const imageBlob = new Blob([
											imageArrayBuffer,
										]);
										const imageToUpload = new File(
											[imageBlob],
											imageFile.name.replace(/\s/g, ""),
											{
												type: "image/png",
											},
										);

										// 先备份原始图片（在上传前）
										try {
											console.log(
												`开始备份图片: ${imageFile.name}, 备份路径: ${noteBackupFolderPath}`,
											);
											const backupImagePath = `${noteBackupFolderPath}/${imageFile.name}`;
											console.log(
												`完整备份路径: ${backupImagePath}`,
											);
											const existingImageBackup =
												this.app.vault.getAbstractFileByPath(
													backupImagePath,
												);
											if (!existingImageBackup) {
												console.log(
													`开始创建二进制文件, 大小: ${imageArrayBuffer.byteLength}`,
												);
												await this.app.vault.createBinary(
													backupImagePath,
													imageArrayBuffer,
												);
												console.log(
													`备份成功: ${imageFile.name}`,
												);
												new Notice(
													`已备份原始图片: ${imageFile.name}`,
												);
											} else {
												console.log(
													`备份文件已存在: ${backupImagePath}`,
												);
											}
										} catch (backupError) {
											console.error(
												`备份图片 ${imageFile.name} 失败:`,
												backupError,
											);
											new Notice(
												`备份图片失败: ${backupError.message}`,
											);
										}

										// 创建备份回调函数（不使用）
										const backupCallback = async (
											fileName: string,
										) => {
											// 备份逻辑已在上传前执行
										};

										const url =
											await this.uploader.uploadFile(
												imageToUpload,
												backupCallback,
											);

										if (
											newContent.includes(
												`![[${imagePath}]]`,
											)
										) {
											newContent = newContent.replace(
												`![[${imagePath}]]`,
												`![${imageFile.name}](${url})`,
											);
										} else {
											const pattern = `](${imagePath})`;
											newContent = newContent
												.split(pattern)
												.join(`](${url})`);
										}

										await this.app.fileManager.trashFile(
											imageFile,
										);
										new Notice(
											`图片 ${imageFile.name} 上传成功`,
										);
									} catch (error) {
										new Notice(
											`图片 ${imagePath} 上传失败: ${error.message}`,
										);
										console.error("Upload error:", error);
									}
								}

								if (newContent !== content) {
									await this.app.vault.modify(
										file,
										newContent,
									);
									new Notice("所有图片链接已更新");
								}
							} catch (error) {
								new Notice(`处理失败: ${error.message}`);
								console.error("Process error:", error);
							}
						});
				});

				menu.addItem((item) => {
					item.setTitle("刷新图片有效期")
						.setIcon("refresh-cw")
						.onClick(async () => {
							try {
								const content = await this.app.vault.read(file);

								const imageRegex = /!\[.*?\]\((.*?)\)/g;
								const matches = [
									...content.matchAll(imageRegex),
								];

								if (matches.length === 0) {
									new Notice("未找到图片链接");
									return;
								}

								let newContent = content;
								for (const match of matches) {
									const imageUrl = match[1];

									try {
										const urlPath = new URL(imageUrl)
											.pathname;
										const fileName = decodeURIComponent(
											urlPath.substring(
												urlPath.lastIndexOf("/") + 1,
											),
										);

										const refreshedUrl =
											await this.uploader.refreshSignedUrl(
												fileName,
											);

										newContent = newContent.replace(
											imageUrl,
											refreshedUrl,
										);
										new Notice(
											`图片 ${fileName} 有效期已刷新`,
										);
									} catch (error) {
										new Notice(
											`刷新图片 ${imageUrl} 失败: ${error.message}`,
										);
										console.error("Refresh error:", error);
									}
								}

								if (newContent !== content) {
									await this.app.vault.modify(
										file,
										newContent,
									);
									new Notice("所有图片链接有效期已刷新");
								}
							} catch (error) {
								new Notice(`处理失败: ${error.message}`);
								console.error("Process error:", error);
							}
						});
				});
			}),
		);

		// 添加图片管理命令
		this.addCommand({
			id: "manage-cos-images",
			name: "管理COS图片",
			callback: () => {
				if (!this.uploader) {
					new Notice("请先配置COS设置");
					return;
				}
				new ImageManagerModal(this.app, this.uploader).open();
			},
		});

		this.addSettingTab(new ImgurSettingTab(this.app, this, initUploader));

		this.registerInterval(window.setInterval(() => {}, 5 * 60 * 1000));
	}

	onunload() {
		if (this.uploader) {
			this.uploader.cleanup();
		}
		new Notice("你的图床插件已卸载!");
	}

	// 备份图片的辅助函数
	private async backupImage(
		file: File,
		activeFile: TFile,
		actionType = "图片",
	): Promise<string | null> {
		try {
			console.log(
				`开始备份${actionType}:`,
				file.name,
				`大小: ${file.size} bytes`,
			);

			// 创建备份文件夹
			let backupFolderPath: string;
			if (this.settings.backupPath) {
				backupFolderPath = this.settings.backupPath.startsWith("/")
					? this.settings.backupPath.substring(1)
					: this.settings.backupPath;
			} else {
				backupFolderPath = `${activeFile.parent?.path || ""}/备份`;
			}

			console.log(`备份文件夹路径: ${backupFolderPath}`);

			// 确保备份根文件夹存在
			try {
				let backupFolder =
					this.app.vault.getAbstractFileByPath(backupFolderPath);
				if (!backupFolder) {
					console.log(`创建备份根文件夹: ${backupFolderPath}`);
					backupFolder =
						await this.app.vault.createFolder(backupFolderPath);
				} else {
					console.log(`备份根文件夹已存在: ${backupFolderPath}`);
				}
			} catch (error) {
				if (!error.message.includes("already exists")) {
					console.error(`创建备份根文件夹失败:`, error);
					throw error;
				}
				console.log(
					`备份根文件夹已存在（捕获异常）: ${backupFolderPath}`,
				);
			}

			// 创建笔记对应的子文件夹（不使用时间戳）
			const noteBackupFolderPath = `${backupFolderPath}/${activeFile.basename}`;

			console.log(`笔记备份文件夹路径: ${noteBackupFolderPath}`);

			// 确保笔记备份子文件夹存在
			try {
				let noteBackupFolder =
					this.app.vault.getAbstractFileByPath(noteBackupFolderPath);
				if (!noteBackupFolder) {
					console.log(
						`创建笔记备份子文件夹: ${noteBackupFolderPath}`,
					);
					noteBackupFolder =
						await this.app.vault.createFolder(noteBackupFolderPath);
				} else {
					console.log(
						`笔记备份子文件夹已存在: ${noteBackupFolderPath}`,
					);
				}
			} catch (error) {
				if (!error.message.includes("already exists")) {
					console.error(`创建笔记备份子文件夹失败:`, error);
					throw error;
				}
				console.log(
					`笔记备份子文件夹已存在（捕获异常）: ${noteBackupFolderPath}`,
				);
			}

			const arrayBuffer = await file.arrayBuffer();
			console.log(
				`文件数据读取完成，大小: ${arrayBuffer.byteLength} bytes`,
			);
			// 生成备份文件名，添加时间戳确保唯一性
			const originalName = file.name || `${actionType}-${Date.now()}.png`;
			const extension = originalName.split(".").pop() || "png";
			const nameWithoutExt =
				originalName.substring(0, originalName.lastIndexOf(".")) ||
				originalName;
			const backupFileName = `${nameWithoutExt}-${Date.now()}.${extension}`;
			const backupImagePath = `${noteBackupFolderPath}/${backupFileName}`;

			console.log(`备份文件路径: ${backupImagePath}`);

			// 检查文件是否已存在，如果存在则跳过
			const existingBackup =
				this.app.vault.getAbstractFileByPath(backupImagePath);
			if (!existingBackup) {
				console.log(`开始创建备份文件...`);
				await this.app.vault.createBinary(backupImagePath, arrayBuffer);
				console.log(`备份文件创建成功: ${backupFileName}`);
				new Notice(`已备份${actionType}: ${backupFileName}`);
				return backupFileName; // 返回备份的文件名
			} else {
				console.log(`备份文件已存在，跳过: ${backupFileName}`);
				new Notice(`${actionType}已存在备份，跳过: ${backupFileName}`);
				return backupFileName; // 返回已存在的备份文件名
			}
		} catch (error) {
			console.error(`备份${actionType} ${file.name} 失败:`, error);
			new Notice(`备份${actionType}失败: ${error.message}`);
			return null; // 备份失败返回null
		}
	}

	// 备份笔记内容的辅助函数
	private async backupNote(
		activeFile: TFile,
		backupImageName?: string | null,
	): Promise<void> {
		try {
			// 创建备份文件夹
			let backupFolderPath: string;
			if (this.settings.backupPath) {
				backupFolderPath = this.settings.backupPath.startsWith("/")
					? this.settings.backupPath.substring(1)
					: this.settings.backupPath;
			} else {
				backupFolderPath = `${activeFile.parent?.path || ""}/备份`;
			}

			// 确保备份根文件夹存在
			try {
				let backupFolder =
					this.app.vault.getAbstractFileByPath(backupFolderPath);
				if (!backupFolder) {
					backupFolder =
						await this.app.vault.createFolder(backupFolderPath);
				}
			} catch (error) {
				if (!error.message.includes("already exists")) {
					throw error;
				}
			}

			// 创建笔记对应的子文件夹
			const noteBackupFolderPath = `${backupFolderPath}/${activeFile.basename}`;

			// 确保笔记备份子文件夹存在
			try {
				let noteBackupFolder =
					this.app.vault.getAbstractFileByPath(noteBackupFolderPath);
				if (!noteBackupFolder) {
					noteBackupFolder =
						await this.app.vault.createFolder(noteBackupFolderPath);
				}
			} catch (error) {
				if (!error.message.includes("already exists")) {
					throw error;
				}
			}

			// 备份笔记内容（包含最新的图片链接）
			const noteBackupFileName = `${activeFile.basename}-backup.md`;
			const noteBackupFilePath = `${noteBackupFolderPath}/${noteBackupFileName}`;

			try {
				let noteContent = await this.app.vault.read(activeFile);

				// 将云端图片链接替换为本地备份图片的链接
				if (backupImageName) {
					// 查找最新添加的云端链接并替换为本地备份链接
					const cloudLinkRegex = /!\[([^\]]*)\]\(https:\/\/[^)]+\)/g;
					const matches = [...noteContent.matchAll(cloudLinkRegex)];

					if (matches.length > 0) {
						// 替换最后一个云端链接（最新添加的）
						const lastMatch = matches[matches.length - 1];
						const localImageLink = `![[${backupImageName}]]`;
						noteContent = noteContent.replace(
							lastMatch[0],
							localImageLink,
						);
					}
				}

				const existingNoteBackup =
					this.app.vault.getAbstractFileByPath(noteBackupFilePath);

				if (existingNoteBackup) {
					// 如果备份已存在，更新内容
					await this.app.vault.modify(
						existingNoteBackup as TFile,
						noteContent,
					);
					new Notice(`已更新笔记备份: ${noteBackupFileName}`);
				} else {
					// 如果备份不存在，创建新备份
					await this.app.vault.create(
						noteBackupFilePath,
						noteContent,
					);
					new Notice(`已备份笔记: ${noteBackupFileName}`);
				}
			} catch (error) {
				console.error(`备份笔记内容失败:`, error);
				new Notice(`备份笔记失败: ${error.message}`);
			}
		} catch (error) {
			console.error(`备份笔记失败:`, error);
			new Notice(`备份笔记失败: ${error.message}`);
		}
	}

	async loadSettings() {
		this.settings = Object.assign(
			{},
			DEFAULT_SETTINGS,
			await this.loadData(),
		);
	}

	async saveSettings() {
		await this.saveData(this.settings);
	}

	private findImageFile(imagePath: string, currentFile: TFile): TFile | null {
		// 移除可能的路径前缀
		const cleanPath = imagePath.split("/").pop() || imagePath;

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

		// 4. 递归搜索整个vault，使用清理后的文件名
		const files = this.app.vault.getFiles();
		const foundFile = files.find(
			(file) => file.name === cleanPath && this.isImageFile(file),
		);
		if (foundFile) {
			return foundFile;
		}

		// 5. 如果还是找不到，尝试模糊匹配（处理可能的路径问题）
		return (
			files.find(
				(file) => file.name === imagePath && this.isImageFile(file),
			) || null
		);
	}

	private isImageFile(file: TFile): boolean {
		return (
			file.extension.toLowerCase().match(/png|jpg|jpeg|gif|svg|webp/i) !==
			null
		);
	}

	//#region 注册图片大小调整功能

	// 注册图片大小调整功能
	private registerImageResizer() {
		// 监听预览模式中的图片
		this.registerDomEvent(document, "mousedown", (evt: MouseEvent) => {
			const target = evt.target as HTMLElement;
			if (target.tagName === "IMG") {
				const previewView = target.closest(".markdown-preview-view");
				const editView = target.closest(".markdown-source-view");

				if (previewView || editView) {
					this.handleImageResize(evt, target as HTMLImageElement);
				}
			}
		});

		// 监听编辑器内容变化，为新插入的图片添加大小调整功能
		this.registerEvent(
			this.app.workspace.on("active-leaf-change", () => {
				this.addImageResizeHandlers();
			}),
		);

		// 初始化当前活动编辑器的图片处理
		this.addImageResizeHandlers();
	}

	// 为编辑器中的图片添加大小调整处理
	private addImageResizeHandlers() {
		const activeView = this.app.workspace.getActiveViewOfType(MarkdownView);
		if (!activeView) return;

		// 为预览模式和编辑模式都添加处理
		setTimeout(() => {
			const container = activeView.containerEl;
			const images = container.querySelectorAll("img");

			images.forEach((img) => {
				// 避免重复添加事件监听器
				if (!img.hasAttribute("data-resize-enabled")) {
					img.setAttribute("data-resize-enabled", "true");
					img.style.cursor = "ew-resize";

					img.addEventListener("mousedown", (evt: MouseEvent) => {
						evt.preventDefault();
						this.handleImageResize(evt, img);
					});
				}
			});
		}, 100);
	}

	// 处理图片大小调整
	private handleImageResize(evt: MouseEvent, img: HTMLImageElement) {
		evt.preventDefault();
		evt.stopPropagation();

		const startX = evt.clientX;
		const startWidth = img.offsetWidth;
		let isDragging = false;

		const onMouseMove = (e: MouseEvent) => {
			if (!isDragging && Math.abs(e.clientX - startX) > 5) {
				isDragging = true;
				img.style.cursor = "ew-resize";
				document.body.style.cursor = "ew-resize";
			}

			if (isDragging) {
				const deltaX = e.clientX - startX;
				const newWidth = Math.max(50, startWidth + deltaX);
				img.style.width = newWidth + "px";
				img.style.height = "auto";

				// 实时显示大小提示
				this.showResizeTooltip(
					e.clientX,
					e.clientY,
					Math.round(newWidth),
				);
			}
		};

		const onMouseUp = async () => {
			document.body.style.cursor = "";
			this.hideResizeTooltip();

			if (isDragging) {
				img.style.cursor = "ew-resize";
				await this.updateImageSizeInMarkdown(img);
			}

			document.removeEventListener("mousemove", onMouseMove);
			document.removeEventListener("mouseup", onMouseUp);
		};

		document.addEventListener("mousemove", onMouseMove);
		document.addEventListener("mouseup", onMouseUp);
	}

	// 显示调整大小的提示
	private showResizeTooltip(x: number, y: number, width: number) {
		let tooltip = document.getElementById("image-resize-tooltip");
		if (!tooltip) {
			tooltip = document.createElement("div");
			tooltip.id = "image-resize-tooltip";
			tooltip.style.cssText = `
				position: fixed;
				background: var(--background-primary);
				border: 1px solid var(--background-modifier-border);
				border-radius: 4px;
				padding: 4px 8px;
				font-size: 12px;
				z-index: 10000;
				pointer-events: none;
				box-shadow: 0 2px 8px rgba(0,0,0,0.1);
			`;
			document.body.appendChild(tooltip);
		}

		tooltip.textContent = `${width}px`;
		tooltip.style.left = x + 10 + "px";
		tooltip.style.top = y - 30 + "px";
		tooltip.style.display = "block";
	}

	// 隐藏调整大小的提示
	private hideResizeTooltip() {
		const tooltip = document.getElementById("image-resize-tooltip");
		if (tooltip) {
			tooltip.style.display = "none";
		}
	}

	// 更新 Markdown 中的图片大小
	private async updateImageSizeInMarkdown(img: HTMLImageElement) {
		const activeView = this.app.workspace.getActiveViewOfType(MarkdownView);
		if (!activeView) return;

		const editor = activeView.editor;
		const content = editor.getValue();
		const imgSrc = img.src;
		const newWidth = Math.round(img.offsetWidth);

		// 提取图片的关键信息用于匹配
		const imgInfo = this.extractImageInfo(imgSrc);
		if (!imgInfo) {
			new Notice("无法识别图片信息");
			return;
		}

		let newContent = content;
		let updated = false;

		// 匹配各种可能的 Markdown 图片语法
		const patterns = [
			// 标准语法：![alt](url) 或 ![alt*width](url)
			{ regex: /!\[([^\]]*?)(?:\*\d+)?\]\(([^)]+)\)/g, type: "markdown" },
			// Wiki 链接：![[filename]] 或 ![[filename|width]]
			{ regex: /!\[\[([^\]]+?)(?:\|\d+)?\]\]/g, type: "wiki" },
			// HTML img 标签
			{ regex: /<img[^>]+src=["']([^"']+)["'][^>]*>/g, type: "html" },
		];

		for (const pattern of patterns) {
			pattern.regex.lastIndex = 0; // 重置正则表达式
			let match;

			while ((match = pattern.regex.exec(content)) !== null) {
				const fullMatch = match[0];

				// 检查是否匹配当前图片
				if (this.isMatchingImage(match, imgInfo, pattern.type)) {
					let replacement;

					if (pattern.type === "markdown") {
						// 标准 Markdown 语法
						const altText = match[1] || "";
						const url = match[2];
						replacement = `![${altText}*${newWidth}](${url})`;
					} else if (pattern.type === "wiki") {
						// Wiki 链接语法
						const filename = match[1];
						const baseFilename = filename.split("|")[0];
						replacement = `![[${baseFilename}|${newWidth}]]`;
					} else if (pattern.type === "html") {
						// HTML 语法 - 更新 width 属性
						replacement = fullMatch.replace(
							/width=["']\d+["']/g,
							`width="${newWidth}"`,
						);
						if (!replacement.includes("width=")) {
							replacement = replacement.replace(
								/<img/,
								`<img width="${newWidth}"`,
							);
						}
					}

					if (replacement && replacement !== fullMatch) {
						newContent = newContent.replace(fullMatch, replacement);
						updated = true;
						break; // 找到第一个匹配就停止
					}
				}
			}

			if (updated) break; // 如果已经更新，不需要继续其他模式
		}

		if (updated) {
			editor.setValue(newContent);
			new Notice(`图片大小已调整为 ${newWidth}px`);
		} else {
			new Notice("未能更新图片大小到 Markdown 源码");
		}
	}

	// 提取图片信息用于匹配
	private extractImageInfo(
		imgSrc: string,
	): { filename: string; domain: string; path: string } | null {
		try {
			const url = new URL(imgSrc);
			const pathname = url.pathname;
			const filename = pathname.split("/").pop() || "";

			return {
				filename: filename.split("?")[0], // 去掉查询参数
				domain: url.hostname,
				path: pathname,
			};
		} catch (e) {
			// 如果不是完整 URL，尝试提取文件名
			const filename = imgSrc.split("/").pop()?.split("?")[0] || "";
			return filename ? { filename, domain: "", path: imgSrc } : null;
		}
	}

	// 检查图片匹配
	private isMatchingImage(
		match: RegExpExecArray,
		imgInfo: { filename: string; domain: string; path: string },
		type: string,
	): boolean {
		let url = "";

		if (type === "markdown") {
			url = match[2]; // URL 在第二个捕获组
		} else if (type === "wiki") {
			url = match[1]; // 文件名在第一个捕获组
		} else if (type === "html") {
			// 从 HTML 标签中提取 src
			const srcMatch = match[0].match(/src=["']([^"']+)["']/);
			url = srcMatch ? srcMatch[1] : "";
		}

		if (!url) return false;

		// 检查文件名匹配
		if (imgInfo.filename && url.includes(imgInfo.filename)) {
			return true;
		}

		// 检查域名匹配
		if (imgInfo.domain && url.includes(imgInfo.domain)) {
			return true;
		}

		// 检查路径匹配
		if (
			imgInfo.path &&
			(url.includes(imgInfo.path) || imgInfo.path.includes(url))
		) {
			return true;
		}

		// 模糊匹配：检查 URL 的关键部分
		try {
			const urlObj = new URL(url);
			const urlFilename =
				urlObj.pathname.split("/").pop()?.split("?")[0] || "";
			if (urlFilename === imgInfo.filename) {
				return true;
			}
		} catch (e) {
			// 如果不是完整 URL，进行简单的字符串匹配
			if (
				url.includes(imgInfo.filename) ||
				imgInfo.filename.includes(url)
			) {
				return true;
			}
		}

		return false;
	}
}

//#endregion

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

		const debouncedInit = this.debounce(() => {
			this.initUploader();
		}, 2000);

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
					}),
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
					}),
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
					}),
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
					.addOption("ap-nanjing", "南京")
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
						let prefix = value.trim();
						prefix = prefix.replace(/^\/+|\/+$/g, "");
						this.plugin.settings.prefix = prefix;
						await this.plugin.saveSettings();
					}),
			);

		new Setting(containerEl)
			.setName("备份路径")
			.setDesc(
				"设置备份文件的存储路径，默认为空则备份到当前笔记同级目录的备份文件夹",
			)
			.addText((text) => {
				// 获取所有文件夹
				const allFiles = this.app.vault.getAllLoadedFiles();
				const folders: string[] = [];

				allFiles.forEach((file) => {
					const fileWithChildren = file as {
						children?: unknown;
						path: string;
					};
					if (fileWithChildren.children !== undefined) {
						folders.push(fileWithChildren.path);
					}
				});

				folders.sort();

				text.setPlaceholder("留空则使用默认路径")
					.setValue(this.plugin.settings.backupPath)
					.onChange(async (value) => {
						this.plugin.settings.backupPath = value;
						await this.plugin.saveSettings();
					});

				// 聚焦时显示文件夹列表
				const inputEl = text.inputEl;
				let suggestionsList: HTMLElement | null = null;

				inputEl.addEventListener("focus", () => {
					// 创建建议列表容器
					if (!suggestionsList) {
						suggestionsList = document.createElement("div");
						suggestionsList.className = "backup-path-suggestions";
						suggestionsList.style.cssText =
							"position: absolute; top: calc(100% + 4px); left: 0; right: 0; background: var(--background-primary); border: 1px solid var(--background-modifier-border); border-radius: 8px; max-height: 200px; overflow-y: auto; z-index: 1000; box-shadow: 0 2px 8px rgba(0, 0, 0, 0.1); padding: 4px;";
						inputEl.parentElement?.style.setProperty(
							"position",
							"relative",
						);
						inputEl.parentElement?.appendChild(suggestionsList);
					}

					suggestionsList.innerHTML = "";
					folders.forEach((folder) => {
						const item = document.createElement("div");
						item.className = "suggestion-item";
						item.style.cssText =
							"padding: 8px 12px; cursor: pointer; transition: background-color 0.15s ease; font-size: 13px; color: var(--text-normal); border-radius: 4px; margin: 2px 0; text-align: left; line-height: 1.4;";
						item.textContent = folder || "/";
						item.addEventListener("click", () => {
							text.setValue(folder);
							this.plugin.settings.backupPath = folder;
							this.plugin.saveSettings();
							if (suggestionsList) {
								suggestionsList.style.display = "none";
							}
						});
						item.addEventListener("mouseenter", () => {
							item.style.backgroundColor =
								"var(--background-modifier-hover)";
						});
						item.addEventListener("mouseleave", () => {
							item.style.backgroundColor = "transparent";
						});
						if (suggestionsList) {
							suggestionsList.appendChild(item);
						}
					});

					if (suggestionsList) {
						suggestionsList.style.display = "block";
					}
				});

				inputEl.addEventListener("blur", () => {
					if (suggestionsList) {
						setTimeout(() => {
							if (suggestionsList) {
								suggestionsList.style.display = "none";
							}
						}, 200);
					}
				});
			});

		new Setting(containerEl)
			.setName("图片有效期")
			.setDesc("设置图片链接的有效期")
			.addDropdown((dropdown) => {
				dropdown
					.addOption((1 * 30 * 24 * 60 * 60).toString(), "1个月")
					.addOption((6 * 30 * 24 * 60 * 60).toString(), "半年")
					.addOption((12 * 30 * 24 * 60 * 60).toString(), "1年")
					.addOption((36 * 30 * 24 * 60 * 60).toString(), "3年")
					.addOption((60 * 30 * 24 * 60 * 60).toString(), "5年")
					.addOption((20 * 365 * 24 * 60 * 60).toString(), "20年")
					.addOption((50 * 365 * 24 * 60 * 60).toString(), "50年")
					.addOption((100 * 365 * 24 * 60 * 60).toString(), "永久")
					.setValue(this.plugin.settings.expiration.toString())
					.onChange(async (value) => {
						const expiration = parseInt(value, 10);
						if (!isNaN(expiration) && expiration > 0) {
							this.plugin.settings.expiration = expiration;
							await this.plugin.saveSettings();
						} else {
							new Notice("请选择有效的时间选项");
						}
					});
			});

		// 添加图片管理按钮
		new Setting(containerEl)
			.setName("图片管理")
			.setDesc("查看和管理已上传到COS的图片")
			.addButton((button) => {
				button
					.setButtonText("打开图片管理")
					.setCta()
					.onClick(() => {
						if (!this.plugin.uploader) {
							new Notice("请先配置COS设置");
							return;
						}
						new ImageManagerModal(
							this.app,
							this.plugin.uploader,
						).open();
					});
			});
	}

	private debounce(func: (...args: unknown[]) => void, wait: number) {
		let timeout: NodeJS.Timeout;
		return function executedFunction(...args: unknown[]) {
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
	private cos: COS;
	private settings: ImgurPluginSettings;
	private urlCache: Map<string, string>;
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
	}

	public cleanup() {
		if (this.updateInterval) {
			clearInterval(this.updateInterval);
			this.updateInterval = null;
		}
	}

	async uploadFile(
		file: File,
		backupCallback?: (fileName: string) => Promise<void>,
	): Promise<string> {
		if (!this.settings.bucket || !this.settings.region) {
			throw new Error("请先配置存储桶和地域信息");
		}

		const originalName = file.name;
		const extension = originalName.split(".").pop();
		const nameWithoutExt = originalName.substring(
			0,
			originalName.lastIndexOf("."),
		);
		const processedName = nameWithoutExt.replace(/\s+/g, "-");
		const fileName = `${Date.now()}-${processedName}.${extension}`;

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
				async (err: COS.CosError | null, data: COS.PutObjectResult) => {
					if (err) {
						console.error("上传错误:", err);
						reject(err);
						return;
					}

					try {
						// 上传成功后备份原始图片
						if (backupCallback) {
							try {
								await backupCallback(fileName);
							} catch (backupError) {
								console.warn("备份原始图片失败:", backupError);
								// 备份失败不影响上传流程
							}
						}

						const url = await this.getSignedUrl(fullPath);
						this.urlCache.set(fullPath, url);
						resolve(url);
					} catch (error) {
						reject(error);
					}
				},
			);
		});
	}

	private getSignedUrl(
		fileName: string,
		prefix?: string,
		expires?: number,
	): Promise<string> {
		const expiration = expires || this.settings.expiration;
		return new Promise((resolve, reject) => {
			this.cos.getObjectUrl(
				{
					Bucket: this.settings.bucket,
					Region: this.settings.region,
					Key: prefix ? prefix + fileName : fileName,
					Sign: true,
					Expires: expiration,
				},
				(err: COS.CosError | null, data: COS.GetObjectUrlResult) => {
					if (err) {
						reject(err);
						return;
					}
					resolve(
						data.Url +
							(data.Url.indexOf("?") > -1 ? "&" : "?") +
							"response-content-disposition=inline",
					);
				},
			);
		});
	}

	async refreshSignedUrl(fileName: string): Promise<string> {
		return this.getSignedUrl(fileName, this.settings.prefix + "/");
	}

	//#region COS 图片管理

	// 列出存储桶中的图片
	async listImages(marker?: string): Promise<{
		images: Array<{
			key: string;
			size: number;
			lastModified: string;
			url: string;
		}>;
		isTruncated: boolean;
		nextMarker?: string;
	}> {
		return new Promise((resolve, reject) => {
			const prefix = this.settings.prefix
				? `${this.settings.prefix}/`
				: "";

			this.cos.getBucket(
				{
					Bucket: this.settings.bucket,
					Region: this.settings.region,
					Prefix: prefix,
					Marker: marker || "",
					MaxKeys: 100,
				},
				async (err: COS.CosError | null, data: any) => {
					if (err) {
						reject(err);
						return;
					}

					try {
						const images = [];
						for (const item of data.Contents || []) {
							// 只处理图片文件
							if (this.isImageFile(item.Key)) {
								const url = await this.getSignedUrl(item.Key);
								images.push({
									key: item.Key,
									size: parseInt(item.Size),
									lastModified: item.LastModified,
									url: url,
								});
							}
						}

						resolve({
							images,
							isTruncated: data.IsTruncated === "true",
							nextMarker: data.NextMarker,
						});
					} catch (error) {
						reject(error);
					}
				},
			);
		});
	}

	// 删除单个图片
	async deleteImage(key: string): Promise<void> {
		return new Promise((resolve, reject) => {
			this.cos.deleteObject(
				{
					Bucket: this.settings.bucket,
					Region: this.settings.region,
					Key: key,
				},
				(err: COS.CosError | null) => {
					if (err) {
						reject(err);
						return;
					}
					resolve();
				},
			);
		});
	}

	// 批量删除图片
	async deleteMultipleImages(keys: string[]): Promise<{
		deleted: string[];
		errors: Array<{ key: string; error: string }>;
	}> {
		return new Promise((resolve, reject) => {
			const objects = keys.map((key) => ({ Key: key }));

			this.cos.deleteMultipleObject(
				{
					Bucket: this.settings.bucket,
					Region: this.settings.region,
					Objects: objects,
					Quiet: false,
				},
				(err: COS.CosError | null, data: any) => {
					if (err) {
						reject(err);
						return;
					}

					const deleted = (data.Deleted || []).map(
						(item: any) => item.Key,
					);
					const errors = (data.Error || []).map((item: any) => ({
						key: item.Key,
						error: item.Message || item.Code,
					}));

					resolve({ deleted, errors });
				},
			);
		});
	}

	// 检查是否为图片文件
	private isImageFile(key: string): boolean {
		const extension = key.split(".").pop()?.toLowerCase();
		return ["png", "jpg", "jpeg", "gif", "svg", "webp", "bmp"].includes(
			extension || "",
		);
	}
}
// 图片管理Modal
class ImageManagerModal extends Modal {
	private uploader: COSUploader;
	private images: Array<{
		key: string;
		size: number;
		lastModified: string;
		url: string;
		selected?: boolean;
	}> = [];
	private selectedImages: Set<string> = new Set();
	private currentMarker?: string;
	private hasMore = false;
	private loading = false;

	constructor(app: App, uploader: COSUploader) {
		super(app);
		this.uploader = uploader;
	}

	onOpen() {
		const { contentEl } = this;
		contentEl.empty();

		contentEl.createEl("h2", { text: "COS 图片管理" });

		// 创建工具栏
		const toolbar = contentEl.createDiv("image-manager-toolbar");
		toolbar.style.cssText = `
			display: flex;
			justify-content: space-between;
			align-items: center;
			margin-bottom: 16px;
			padding: 8px 0;
			border-bottom: 1px solid var(--background-modifier-border);
		`;

		const leftActions = toolbar.createDiv();
		const rightActions = toolbar.createDiv();

		// 全选/取消全选按钮
		const selectAllBtn = new ButtonComponent(leftActions);
		selectAllBtn.setButtonText("全选").onClick(() => {
			if (this.selectedImages.size === this.images.length) {
				this.selectedImages.clear();
				selectAllBtn.setButtonText("全选");
			} else {
				this.images.forEach((img) => this.selectedImages.add(img.key));
				selectAllBtn.setButtonText("取消全选");
			}
			this.updateImageList();
		});

		// 删除选中按钮
		const deleteBtn = new ButtonComponent(leftActions);
		deleteBtn.setButtonText("删除选中").onClick(() => {
			if (this.selectedImages.size === 0) {
				new Notice("请先选择要删除的图片");
				return;
			}
			this.deleteSelectedImages();
		});

		// 刷新按钮
		const refreshBtn = new ButtonComponent(rightActions);
		refreshBtn.setButtonText("刷新").onClick(() => {
			this.loadImages(true);
		});

		// 创建图片列表容器
		const listContainer = contentEl.createDiv("image-list-container");
		listContainer.style.cssText = `
			max-height: 500px;
			overflow-y: auto;
			border: 1px solid var(--background-modifier-border);
			border-radius: 8px;
		`;

		this.loadImages();
	}

	private async loadImages(reset = false) {
		if (this.loading) return;

		this.loading = true;

		try {
			if (reset) {
				this.images = [];
				this.currentMarker = undefined;
				this.selectedImages.clear();
			}

			const result = await this.uploader.listImages(this.currentMarker);

			if (reset) {
				this.images = result.images;
			} else {
				this.images.push(...result.images);
			}

			this.hasMore = result.isTruncated;
			this.currentMarker = result.nextMarker;

			this.updateImageList();
		} catch (error) {
			new Notice(`加载图片失败: ${error.message}`);
			console.error("Load images error:", error);
		} finally {
			this.loading = false;
		}
	}

	private updateImageList() {
		const container = this.contentEl.querySelector(".image-list-container");
		if (!container) return;

		container.empty();

		if (this.images.length === 0) {
			const emptyDiv = container.createDiv();
			emptyDiv.style.cssText = `
				text-align: center;
				padding: 40px;
				color: var(--text-muted);
			`;
			emptyDiv.textContent = "暂无图片";
			return;
		}

		// 创建图片网格
		const grid = container.createDiv("image-grid");
		grid.style.cssText = `
			display: grid;
			grid-template-columns: repeat(auto-fill, minmax(200px, 1fr));
			gap: 16px;
			padding: 16px;
		`;

		this.images.forEach((image) => {
			const item = grid.createDiv("image-item");
			item.style.cssText = `
				border: 1px solid var(--background-modifier-border);
				border-radius: 8px;
				overflow: hidden;
				transition: all 0.2s ease;
				cursor: pointer;
				${this.selectedImages.has(image.key) ? "border-color: var(--interactive-accent); box-shadow: 0 0 0 2px var(--interactive-accent-hover);" : ""}
			`;

			// 选择框
			const checkbox = item.createEl("input", { type: "checkbox" });
			checkbox.style.cssText = `
				position: absolute;
				top: 8px;
				left: 8px;
				z-index: 1;
			`;
			checkbox.checked = this.selectedImages.has(image.key);
			checkbox.addEventListener("change", () => {
				if (checkbox.checked) {
					this.selectedImages.add(image.key);
				} else {
					this.selectedImages.delete(image.key);
				}
				this.updateImageList();
			});

			// 图片预览
			const imgContainer = item.createDiv();
			imgContainer.style.cssText = `
				position: relative;
				height: 150px;
				background: var(--background-secondary);
				display: flex;
				align-items: center;
				justify-content: center;
			`;

			const img = imgContainer.createEl("img");
			img.src = image.url;
			img.style.cssText = `
				max-width: 100%;
				max-height: 100%;
				object-fit: contain;
			`;

			// 图片信息
			const info = item.createDiv();
			info.style.cssText = `
				padding: 12px;
				background: var(--background-primary);
			`;

			const fileName = info.createDiv();
			fileName.style.cssText = `
				font-weight: 500;
				margin-bottom: 4px;
				word-break: break-all;
				font-size: 12px;
			`;
			fileName.textContent = image.key.split("/").pop() || image.key;

			const details = info.createDiv();
			details.style.cssText = `
				font-size: 11px;
				color: var(--text-muted);
				display: flex;
				justify-content: space-between;
			`;

			const size = details.createSpan();
			size.textContent = this.formatFileSize(image.size);

			const date = details.createSpan();
			date.textContent = new Date(
				image.lastModified,
			).toLocaleDateString();

			// 点击选择
			item.addEventListener("click", (e) => {
				if (e.target === checkbox) return;
				checkbox.checked = !checkbox.checked;
				checkbox.dispatchEvent(new Event("change"));
			});
		});

		// 加载更多按钮
		if (this.hasMore) {
			const loadMoreBtn = container.createDiv();
			loadMoreBtn.style.cssText = `
				text-align: center;
				padding: 16px;
			`;

			const btn = new ButtonComponent(loadMoreBtn);
			btn.setButtonText("加载更多").onClick(() => {
				this.loadImages();
			});
		}
	}

	private async deleteSelectedImages() {
		if (this.selectedImages.size === 0) return;

		const keys = Array.from(this.selectedImages);

		// 显示确认对话框
		const confirmed = await this.showDeleteConfirmDialog(keys.length);
		if (!confirmed) return;

		try {
			const result = await this.uploader.deleteMultipleImages(keys);

			if (result.deleted.length > 0) {
				new Notice(`成功删除 ${result.deleted.length} 张图片`);

				// 从列表中移除已删除的图片
				this.images = this.images.filter(
					(img) => !result.deleted.includes(img.key),
				);
				result.deleted.forEach((key) =>
					this.selectedImages.delete(key),
				);

				this.updateImageList();
			}

			if (result.errors.length > 0) {
				new Notice(`${result.errors.length} 张图片删除失败`);
				console.error("Delete errors:", result.errors);
			}
		} catch (error) {
			new Notice(`删除失败: ${error.message}`);
			console.error("Delete error:", error);
		}
	}

	private showDeleteConfirmDialog(count: number): Promise<boolean> {
		return new Promise((resolve) => {
			const modal = new DeleteConfirmModal(this.app, count, resolve);
			modal.open();
		});
	}

	private formatFileSize(bytes: number): string {
		if (bytes === 0) return "0 B";
		const k = 1024;
		const sizes = ["B", "KB", "MB", "GB"];
		const i = Math.floor(Math.log(bytes) / Math.log(k));
		return parseFloat((bytes / Math.pow(k, i)).toFixed(1)) + " " + sizes[i];
	}

	onClose() {
		const { contentEl } = this;
		contentEl.empty();
	}
}
// 删除确认对话框
class DeleteConfirmModal extends Modal {
	private count: number;
	private resolve: (value: boolean) => void;

	constructor(app: App, count: number, resolve: (value: boolean) => void) {
		super(app);
		this.count = count;
		this.resolve = resolve;
	}

	onOpen() {
		const { contentEl } = this;
		contentEl.empty();

		// 标题
		contentEl.createEl("h2", { text: "确认删除" });

		// 提示信息
		const message = contentEl.createDiv("delete-confirm-message");

		const text = message.createSpan();
		text.textContent = `您确定要删除选中的 ${this.count} 张图片吗？`;

		const subText = message.createDiv("delete-confirm-subtext");
		subText.textContent = "此操作不可撤销，图片将从COS存储中永久删除。";

		// 按钮容器
		const buttonContainer = contentEl.createDiv("delete-confirm-buttons");

		// 取消按钮
		const cancelBtn = new ButtonComponent(buttonContainer);
		cancelBtn.setButtonText("取消").onClick(() => {
			this.resolve(false);
			this.close();
		});

		// 确认删除按钮
		const confirmBtn = new ButtonComponent(buttonContainer);
		confirmBtn
			.setButtonText("确认删除")
			.setCta()
			.onClick(() => {
				this.resolve(true);
				this.close();
			});

		// 添加危险样式类
		confirmBtn.buttonEl.addClass("delete-confirm-btn");
	}

	onClose() {
		const { contentEl } = this;
		contentEl.empty();
		// 如果用户直接关闭对话框，默认为取消
		this.resolve(false);
	}
	//#endregion
}
