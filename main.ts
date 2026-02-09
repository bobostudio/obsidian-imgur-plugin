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
	// 备份操作锁，防止同一笔记并发备份导致冲突
	private backupLocks: Map<string, Promise<void>> = new Map();
	// 备份同步防抖定时器
	private backupSyncTimers: Map<string, NodeJS.Timeout> = new Map();

	async onload() {
		console.log("=== ImgurPlugin 开始加载 ===");
		await this.loadSettings();

		let isFirstInitialization =
			!this.settings.secretId ||
			!this.settings.secretKey ||
			!this.settings.bucket ||
			!this.settings.region;

		console.log("插件设置状态:", {
			hasSecretId: !!this.settings.secretId,
			hasSecretKey: !!this.settings.secretKey,
			hasBucket: !!this.settings.bucket,
			hasRegion: !!this.settings.region,
			isFirstInit: isFirstInitialization,
		});

		const initUploader = async () => {
			console.log("初始化COS上传器，配置检查:", {
				hasSecretId: !!this.settings.secretId,
				hasSecretKey: !!this.settings.secretKey,
				hasBucket: !!this.settings.bucket,
				hasRegion: !!this.settings.region,
				bucket: this.settings.bucket,
				region: this.settings.region,
			});

			if (
				this.settings.secretId &&
				this.settings.secretKey &&
				this.settings.bucket &&
				this.settings.region
			) {
				try {
					console.log("开始创建COSUploader实例...");
					this.uploader = new COSUploader(this.settings);
					console.log("COSUploader实例创建成功");

					// 测试连接
					console.log("开始测试COS连接...");
					const connectionTest = await this.uploader.testConnection();
					if (connectionTest) {
						console.log("COS连接测试通过");
						if (isFirstInitialization) {
							new Notice("腾讯云 COS 配置已完成！");
							isFirstInitialization = false;
						}
					} else {
						console.log("COS连接测试失败");
						new Notice("COS连接测试失败，请检查配置");
					}
				} catch (error) {
					console.error("COSUploader初始化失败:", error);
					new Notice(`插件初始化失败：${error.message}`);
					console.error("Plugin initialization error:", error);
				}
			} else {
				console.log("COS配置不完整，跳过初始化");
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
			await initUploader();
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
					console.log("检测到拖拽事件");
					evt.preventDefault();
					evt.stopPropagation();

					const files = evt.dataTransfer?.files;
					console.log("拖拽的文件数量:", files?.length || 0);

					if (!files || files.length === 0) {
						console.log("没有检测到文件，退出处理");
						return;
					}

					for (let i = 0; i < files.length; i++) {
						const file = files[i];
						console.log(
							"处理拖拽文件:",
							file.name,
							"类型:",
							file.type,
							"大小:",
							file.size,
						);

						// 检查是否为图片文件
						if (!file.type.startsWith("image/")) {
							console.log("跳过非图片文件:", file.name);
							continue;
						}

						try {
							const activeFile = markdownView.file;
							if (!activeFile) {
								new Notice("未找到当前文件");
								continue;
							}

							// 检查uploader是否已初始化
							if (!this.uploader) {
								new Notice("COS上传器未初始化，请检查配置");
								console.error("Uploader not initialized");
								continue;
							}

							console.log("开始处理拖拽的图片文件:", file.name);

							// 上传图片
							const url = await this.uploader.uploadFile(file);
							console.log("拖拽图片上传完成，获得URL:", url);

							// 直接插入云端URL到编辑器
							const pos = editor.getCursor();
							editor.replaceRange(`![${file.name}](${url})`, pos);

							console.log("已插入图片链接到编辑器");
							new Notice("图片上传成功！");
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
					console.log("检测到粘贴事件");
					const files = evt.clipboardData?.files;
					console.log("粘贴的文件数量:", files?.length || 0);

					if (!files || files.length === 0) {
						console.log("没有检测到文件，退出处理");
						return;
					}

					for (let i = 0; i < files.length; i++) {
						const file = files[i];
						console.log(
							"处理粘贴文件:",
							file.name,
							"类型:",
							file.type,
							"大小:",
							file.size,
						);

						// 检查是否为图片文件
						if (!file.type.startsWith("image/")) {
							console.log("跳过非图片文件:", file.name);
							continue;
						}

						evt.preventDefault();

						try {
							const activeFile = markdownView.file;
							if (!activeFile) {
								new Notice("未找到当前文件");
								continue;
							}

							// 检查uploader是否已初始化
							if (!this.uploader) {
								new Notice("COS上传器未初始化，请检查配置");
								console.error("Uploader not initialized");
								continue;
							}

							console.log("开始处理粘贴的图片文件:", file.name);

							// 上传图片
							const url = await this.uploader.uploadFile(file);
							console.log("粘贴图片上传完成，获得URL:", url);

							// 直接插入云端URL到编辑器
							const pos = editor.getCursor();
							editor.replaceRange(`![${file.name}](${url})`, pos);

							console.log("已插入图片链接到编辑器");
							new Notice("图片上传成功！");
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
					item.setTitle("上传本地图片")
						.setIcon("image-plus")
						.onClick(async () => {
							if (!this.uploader) {
								new Notice("COS上传器未初始化，请检查配置");
								return;
							}

							try {
								const content = await this.app.vault.read(file);

								// 查找所有图片引用（包括本地wiki格式和云端URL）
								const wikiImageRegex =
									/!\[\[([^\]]+?)(?:\|[^\]]+)?\]\]/g;
								const markdownImageRegex =
									/!\[([^\]]*?)(?:\*\d+)?\]\(([^)]+)\)/g;

								const wikiMatches = [
									...content.matchAll(wikiImageRegex),
								];
								const markdownMatches = [
									...content.matchAll(markdownImageRegex),
								];

								console.log(
									`找到 ${wikiMatches.length} 个Wiki图片和 ${markdownMatches.length} 个Markdown图片`,
								);

								// 只处理本地wiki图片（不是URL）
								const localWikiImages = wikiMatches.filter(
									(match) => {
										const imagePath =
											match[1].split("|")[0];
										return !imagePath.startsWith("http");
									},
								);

								// 只处理本地markdown图片（不是URL）
								const localMarkdownImages =
									markdownMatches.filter((match) => {
										const imagePath = match[2];
										return !imagePath.startsWith("http");
									});

								const allLocalImages = [
									...localWikiImages,
									...localMarkdownImages,
								];

								if (allLocalImages.length === 0) {
									new Notice("未找到本地图片");
									return;
								}

								console.log(
									`找到 ${allLocalImages.length} 个本地图片`,
								);

								// 创建备份文件夹
								let backupFolderPath: string;
								if (this.settings.backupPath) {
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

								// 创建笔记备份子文件夹
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

								let newContent = content;
								let uploadedCount = 0;

								// 处理每个本地图片
								for (const match of allLocalImages) {
									const fullMatch = match[0];
									let imagePath: string;

									// 判断是wiki格式还是markdown格式
									if (
										match[1] !== undefined &&
										match[2] === undefined
									) {
										// Wiki格式: ![[filename|width]]
										imagePath = match[1].split("|")[0];
									} else {
										// Markdown格式: ![alt](url) 或 ![](url)
										imagePath = match[2];
									}

									console.log(`处理本地图片: ${imagePath}`);

									const imageFile = this.findImageFile(
										imagePath,
										file,
									);

									if (!imageFile) {
										console.log(
											`跳过图片: ${imagePath} (文件不存在)`,
										);
										continue;
									}

									try {
										// 读取图片文件
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
											{ type: "image/png" },
										);

										// 备份原始图片
										try {
											const backupImagePath = `${noteBackupFolderPath}/${imageFile.name}`;
											const existingImageBackup =
												this.app.vault.getAbstractFileByPath(
													backupImagePath,
												);
											if (!existingImageBackup) {
												await this.app.vault.createBinary(
													backupImagePath,
													imageArrayBuffer,
												);
												console.log(
													`备份成功: ${imageFile.name}`,
												);
											}
										} catch (backupError) {
											console.error(
												`备份图片 ${imageFile.name} 失败:`,
												backupError,
											);
										}

										// 上传图片到COS
										console.log(
											`开始上传图片: ${imageFile.name}`,
										);
										const url =
											await this.uploader.uploadFile(
												imageToUpload,
											);
										console.log(
											`图片上传成功，URL: ${url}`,
										);

										// 替换wiki链接为markdown链接
										newContent = newContent.replace(
											fullMatch,
											`![${imageFile.name}](${url})`,
										);

										uploadedCount++;
										new Notice(`已上传: ${imageFile.name}`);
									} catch (error) {
										console.error(
											`上传图片 ${imagePath} 失败:`,
											error,
										);
										new Notice(
											`上传失败: ${imagePath} - ${error.message}`,
										);
									}
								}

								// 更新笔记内容
								if (uploadedCount > 0) {
									await this.app.vault.modify(
										file,
										newContent,
									);
									new Notice(
										`成功上传 ${uploadedCount} 张图片`,
									);
								}

								// 上传完成后，同步备份笔记（使用最新的笔记内容，将云端URL替换为本地备份引用）
								console.log(
									"右键上传完成，开始同步备份笔记...",
								);
								await this.backupNote(file);
							} catch (error) {
								new Notice(`处理失败: ${error.message}`);
								console.error("Process error:", error);
							}
						});
				});

				menu.addItem((item) => {
					item.setTitle("在线笔记备份")
						.setIcon("cloud")
						.onClick(async () => {
							if (!this.uploader) {
								new Notice("COS上传器未初始化，请检查配置");
								return;
							}

							try {
								await this.backupOnlineNote(file);
							} catch (error) {
								new Notice(`处理失败: ${error.message}`);
								console.error("Online backup error:", error);
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

		// 添加上传本地wiki图片命令
		this.addCommand({
			id: "upload-local-wiki-images",
			name: "上传本地Wiki图片到COS",
			editorCallback: async (editor: Editor, view: MarkdownView) => {
				if (!this.uploader) {
					new Notice("请先配置COS设置");
					return;
				}

				const file = view.file;
				if (!file) {
					new Notice("未找到当前文件");
					return;
				}

				try {
					const content = await this.app.vault.read(file);

					// 查找所有wiki格式的本地图片引用
					const wikiImageRegex = /!\[\[([^\]]+?)(?:\|[^\]]+)?\]\]/g;
					const matches = [...content.matchAll(wikiImageRegex)];

					if (matches.length === 0) {
						new Notice("未找到本地Wiki图片");
						return;
					}

					console.log(`找到 ${matches.length} 个Wiki图片引用`);

					let newContent = content;
					let uploadedCount = 0;

					for (const match of matches) {
						const fullMatch = match[0];
						const imagePath = match[1].split("|")[0]; // 获取文件名部分

						console.log(`处理Wiki图片: ${imagePath}`);

						const imageFile = this.findImageFile(imagePath, file);

						if (!imageFile) {
							console.log(`跳过图片: ${imagePath} (文件不存在)`);
							continue;
						}

						try {
							// 读取图片文件
							const imageArrayBuffer =
								await this.app.vault.readBinary(imageFile);
							const imageBlob = new Blob([imageArrayBuffer]);
							const imageToUpload = new File(
								[imageBlob],
								imageFile.name.replace(/\s/g, ""),
								{ type: "image/png" },
							);

							console.log(`开始上传图片: ${imageFile.name}`);

							// 上传图片
							const url =
								await this.uploader.uploadFile(imageToUpload);
							console.log(`图片上传成功，URL: ${url}`);

							// 替换wiki链接为markdown链接
							newContent = newContent.replace(
								fullMatch,
								`![${imageFile.name}](${url})`,
							);

							uploadedCount++;
							new Notice(`已上传: ${imageFile.name}`);
						} catch (error) {
							console.error(`上传图片 ${imagePath} 失败:`, error);
							new Notice(
								`上传失败: ${imagePath} - ${error.message}`,
							);
						}
					}

					// 更新笔记内容
					if (uploadedCount > 0) {
						await this.app.vault.modify(file, newContent);
						new Notice(`成功上传 ${uploadedCount} 张图片`);
					}
				} catch (error) {
					console.error("处理失败:", error);
					new Notice(`处理失败: ${error.message}`);
				}
			},
		});

		// 监听笔记修改事件，自动同步备份（防抖5秒）
		this.registerEvent(
			this.app.vault.on("modify", (file: TFile) => {
				if (!(file instanceof TFile)) return;
				if (file.extension !== "md") return;

				// 跳过备份文件本身（避免无限循环）
				if (file.name.endsWith("-backup.md")) return;

				// 计算备份路径，检查该笔记是否有备份文件夹
				let backupFolderPath: string;
				if (this.settings.backupPath) {
					backupFolderPath = this.settings.backupPath.startsWith("/")
						? this.settings.backupPath.substring(1)
						: this.settings.backupPath;
				} else {
					backupFolderPath = `${file.parent?.path || ""}/备份`;
				}
				const noteBackupFolderPath = `${backupFolderPath}/${file.basename}`;
				const noteBackupFolder =
					this.app.vault.getAbstractFileByPath(noteBackupFolderPath);

				// 只有已经存在备份文件夹的笔记才自动同步
				if (!noteBackupFolder) return;

				console.log(`检测到笔记修改: ${file.path}，准备防抖同步备份`);

				// 清除之前的定时器
				const existingTimer = this.backupSyncTimers.get(file.path);
				if (existingTimer) {
					clearTimeout(existingTimer);
				}

				// 设置新的防抖定时器（5秒后同步）
				const timer = setTimeout(async () => {
					this.backupSyncTimers.delete(file.path);
					try {
						console.log(`自动同步备份笔记: ${file.path}`);
						await this.backupNote(file);
						console.log(`自动同步备份完成: ${file.path}`);
					} catch (error) {
						console.error(`自动同步备份失败: ${file.path}`, error);
					}
				}, 5000);

				this.backupSyncTimers.set(file.path, timer);
			}),
		);

		this.addSettingTab(new ImgurSettingTab(this.app, this, initUploader));

		this.registerInterval(window.setInterval(() => {}, 5 * 60 * 1000));

		console.log("=== ImgurPlugin 加载完成 ===");
	}

	onunload() {
		if (this.uploader) {
			this.uploader.cleanup();
		}
		// 清理所有防抖定时器
		for (const timer of this.backupSyncTimers.values()) {
			clearTimeout(timer);
		}
		this.backupSyncTimers.clear();
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

			// 使用原始文件名作为备份文件名
			const originalName = file.name || `${actionType}.png`;
			let backupFileName = originalName;
			let backupImagePath = `${noteBackupFolderPath}/${backupFileName}`;

			console.log(`备份文件路径: ${backupImagePath}`);

			// 检查文件是否已存在，如果存在则添加数字后缀
			let counter = 1;
			while (this.app.vault.getAbstractFileByPath(backupImagePath)) {
				const extension = originalName.split(".").pop() || "png";
				const nameWithoutExt =
					originalName.substring(0, originalName.lastIndexOf(".")) ||
					originalName;
				backupFileName = `${nameWithoutExt} (${counter}).${extension}`;
				backupImagePath = `${noteBackupFolderPath}/${backupFileName}`;
				counter++;
			}

			console.log(`开始创建备份文件...`);
			await this.app.vault.createBinary(backupImagePath, arrayBuffer);
			console.log(`备份文件创建成功: ${backupFileName}`);
			new Notice(`已备份${actionType}: ${backupFileName}`);
			return backupFileName; // 返回备份的文件名
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
		remoteUrl?: string,
		editorContent?: string,
	): Promise<void> {
		// 使用文件路径作为锁的key，确保同一笔记的备份操作串行执行
		const lockKey = activeFile.path;

		// 等待之前的备份操作完成
		while (this.backupLocks.has(lockKey)) {
			try {
				await this.backupLocks.get(lockKey);
			} catch {
				// 忽略之前的错误
			}
		}

		// 创建新的备份promise
		let resolveLock: () => void;
		let rejectLock: (error: Error) => void;
		const lockPromise = new Promise<void>((resolve, reject) => {
			resolveLock = resolve;
			rejectLock = reject;
		});
		this.backupLocks.set(lockKey, lockPromise);

		try {
			await this.doBackupNote(
				activeFile,
				backupImageName,
				remoteUrl,
				editorContent,
			);
			resolveLock!();
		} catch (error) {
			rejectLock!(error as Error);
			throw error;
		} finally {
			this.backupLocks.delete(lockKey);
		}
	}

	// 在线笔记备份：图片已上传，仅下载远程图片到备份目录并替换为备份地址
	private async backupOnlineNote(activeFile: TFile): Promise<void> {
		const content = await this.app.vault.read(activeFile);

		const markdownImageRegex = /!\[([^\]]*?)\]\((https?:\/\/[^)]+)\)/g;
		const matches = [...content.matchAll(markdownImageRegex)];

		if (matches.length === 0) {
			new Notice("未找到在线图片链接");
			return;
		}

		// 创建备份文件夹
		let backupFolderPath: string;
		if (this.settings.backupPath) {
			backupFolderPath = this.settings.backupPath.startsWith("/")
				? this.settings.backupPath.substring(1)
				: this.settings.backupPath;
		} else {
			backupFolderPath = `${activeFile.parent?.path || ""}/备份`;
		}

		let backupFolder =
			this.app.vault.getAbstractFileByPath(backupFolderPath);
		if (!backupFolder) {
			backupFolder = await this.app.vault.createFolder(backupFolderPath);
		}

		// 创建笔记备份子文件夹
		const noteBackupFolderPath = `${backupFolderPath}/${activeFile.basename}`;
		let noteBackupFolder =
			this.app.vault.getAbstractFileByPath(noteBackupFolderPath);
		if (!noteBackupFolder) {
			noteBackupFolder =
				await this.app.vault.createFolder(noteBackupFolderPath);
		}

		const urlToBackupName = new Map<string, string>();
		let downloadedCount = 0;

		for (const match of matches) {
			const imageUrl = match[2];
			if (urlToBackupName.has(imageUrl)) {
				continue;
			}

			try {
				const urlObj = new URL(imageUrl);
				const rawName = decodeURIComponent(
					urlObj.pathname.substring(
						urlObj.pathname.lastIndexOf("/") + 1,
					),
				);
				const baseName = rawName || `image-${Date.now()}.png`;

				let backupFileName = baseName;
				let backupImagePath = `${noteBackupFolderPath}/${backupFileName}`;
				let counter = 1;
				while (this.app.vault.getAbstractFileByPath(backupImagePath)) {
					const extension = baseName.split(".").pop() || "png";
					const nameWithoutExt =
						baseName.substring(0, baseName.lastIndexOf(".")) ||
						baseName;
					backupFileName = `${nameWithoutExt} (${counter}).${extension}`;
					backupImagePath = `${noteBackupFolderPath}/${backupFileName}`;
					counter++;
				}

				const response = await fetch(imageUrl);
				if (!response.ok) {
					throw new Error(`下载失败: ${response.status}`);
				}

				const buffer = await response.arrayBuffer();
				await this.app.vault.createBinary(backupImagePath, buffer);
				urlToBackupName.set(imageUrl, backupFileName);
				downloadedCount++;
			} catch (error) {
				console.error(`下载图片失败: ${imageUrl}`, error);
				new Notice(`下载失败: ${imageUrl}`);
			}
		}

		let newContent = content;
		for (const [remoteUrl, backupName] of urlToBackupName.entries()) {
			const escapedUrl = this.escapeRegex(remoteUrl);
			const replaceRegex = new RegExp(
				`!\\[([^\\]]*?)\\]\\(${escapedUrl}\\)`,
				"g",
			);
			newContent = newContent.replace(
				replaceRegex,
				`![$1](./${backupName})`,
			);
		}

		if (downloadedCount > 0) {
			await this.backupNote(activeFile, null, undefined, newContent);
			new Notice(`在线笔记备份完成，已下载 ${downloadedCount} 张图片`);
		} else {
			new Notice("未下载到任何图片");
		}
	}

	// 实际执行备份笔记的逻辑
	private async doBackupNote(
		activeFile: TFile,
		backupImageName?: string | null,
		remoteUrl?: string,
		editorContent?: string,
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
				// 优先使用传入的编辑器内容（避免vault.read的时序问题）
				let currentContent: string;
				if (editorContent) {
					currentContent = editorContent;
					console.log(`使用编辑器传入的最新内容进行备份`);
				} else {
					// 等待一小段时间让vault同步编辑器更改
					await new Promise((resolve) => setTimeout(resolve, 300));
					currentContent = await this.app.vault.read(activeFile);
					console.log(`读取当前笔记内容，准备同步到备份`);
				}

				// 如果有新上传的图片，将云端URL替换为本地图片引用
				if (backupImageName && remoteUrl) {
					console.log(
						`将云端URL替换为本地备份图片: ${backupImageName}`,
					);

					// 先尝试简单的字符串替换（处理完整URL）
					const urlWithoutParams = remoteUrl.split("?")[0];

					// 匹配所有可能的图片引用格式
					const patterns = [
						// 完整URL匹配
						new RegExp(
							`!\\[([^\\]]*)\\]\\(${this.escapeRegex(remoteUrl)}\\)`,
							"g",
						),
						// URL不带参数匹配
						new RegExp(
							`!\\[([^\\]]*)\\]\\(${this.escapeRegex(urlWithoutParams)}[^)]*\\)`,
							"g",
						),
					];

					let replaced = false;
					for (const pattern of patterns) {
						if (pattern.test(currentContent)) {
							pattern.lastIndex = 0;
							// 备份笔记和图片在同一个文件夹，使用相对路径
							const localImageLink = `![${backupImageName}](./${backupImageName})`;
							currentContent = currentContent.replace(
								pattern,
								localImageLink,
							);
							console.log(
								`已将远程图片替换为本地引用: ${localImageLink}`,
							);
							replaced = true;
							break;
						}
					}

					if (!replaced) {
						console.log(
							`未找到匹配的远程图片引用，URL: ${remoteUrl}`,
						);
					}
				}

				// 全量扫描：将所有云端图片URL替换为本地备份图片引用
				const backupImageFiles = this.app.vault
					.getFiles()
					.filter(
						(f) =>
							f.path.startsWith(noteBackupFolderPath + "/") &&
							this.isImageFile(f),
					);

				if (backupImageFiles.length > 0) {
					const cloudImageRegex =
						/!\[([^\]]*)\]\((https?:\/\/[^)]+)\)/g;
					const replacements: Array<{
						fullMatch: string;
						replacement: string;
					}> = [];
					let match;

					while (
						(match = cloudImageRegex.exec(currentContent)) !== null
					) {
						const fullMatch = match[0];
						const url = match[2];

						try {
							const urlObj = new URL(url);
							const urlPath = urlObj.pathname;
							const urlFileName = decodeURIComponent(
								urlPath.substring(urlPath.lastIndexOf("/") + 1),
							);

							// 上传文件名格式: ${Date.now()}-${processedName}.${extension}
							// 去掉时间戳前缀得到原始处理后文件名
							const nameWithoutTimestamp = urlFileName.replace(
								/^\d+-/,
								"",
							);

							// 在备份文件中查找匹配
							const matchingBackup = backupImageFiles.find(
								(f) => {
									const backupName = f.name;
									const backupNameNormalized =
										backupName.replace(/\s+/g, "-");
									return (
										backupNameNormalized ===
											nameWithoutTimestamp ||
										backupName === nameWithoutTimestamp ||
										backupNameNormalized.split(".")[0] ===
											nameWithoutTimestamp.split(".")[0]
									);
								},
							);

							if (matchingBackup) {
								replacements.push({
									fullMatch,
									replacement: `![${matchingBackup.name}](./${matchingBackup.name})`,
								});
								console.log(
									`全量替换：云端图片 → 本地备份 ${matchingBackup.name}`,
								);
							}
						} catch (e) {
							// URL解析失败，跳过
						}
					}

					for (const { fullMatch, replacement } of replacements) {
						currentContent = currentContent.replace(
							fullMatch,
							replacement,
						);
					}
				}

				// 检查备份文件是否存在
				let existingBackup =
					this.app.vault.getAbstractFileByPath(noteBackupFilePath);

				if (existingBackup instanceof TFile) {
					// 备份文件已存在，更新内容
					await this.app.vault.modify(existingBackup, currentContent);
					console.log(`已更新备份笔记: ${noteBackupFileName}`);
				} else {
					// 备份文件不存在，创建新文件
					try {
						await this.app.vault.create(
							noteBackupFilePath,
							currentContent,
						);
						console.log(`已创建备份笔记: ${noteBackupFileName}`);
						new Notice(`已创建笔记备份: ${noteBackupFileName}`);
					} catch (createError) {
						// 如果创建失败（可能是文件已存在），尝试修改
						if (
							createError.message &&
							createError.message.includes("already exists")
						) {
							console.log(`备份文件已存在，尝试更新`);
							existingBackup =
								this.app.vault.getAbstractFileByPath(
									noteBackupFilePath,
								);
							if (existingBackup instanceof TFile) {
								await this.app.vault.modify(
									existingBackup,
									currentContent,
								);
								console.log(
									`已更新备份笔记: ${noteBackupFileName}`,
								);
							}
						} else {
							throw createError;
						}
					}
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

	// 转义正则表达式特殊字符
	private escapeRegex(str: string): string {
		return str.replace(/[.*+?^${}()|[\]\\]/g, "\\$&");
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

		console.log("开始更新图片大小:", { imgSrc, newWidth });

		// 提取图片的关键信息用于匹配
		const imgInfo = this.extractImageInfo(imgSrc);
		if (!imgInfo) {
			new Notice("无法识别图片信息");
			return;
		}

		console.log("提取的图片信息:", imgInfo);

		let newContent = content;
		let updated = false;

		// 专门匹配 Markdown 图片语法：![alt](url) 或 ![alt*width](url)
		const markdownImageRegex = /!\[([^\]]*?)\]\(([^)]+)\)/g;
		let match;

		console.log("开始匹配 Markdown 图片语法");

		while ((match = markdownImageRegex.exec(content)) !== null) {
			const fullMatch = match[0];
			const altText = match[1];
			const url = match[2];

			console.log(`找到图片: ${fullMatch}`);
			console.log(`Alt文本: "${altText}", URL: "${url}"`);

			// 检查是否匹配当前图片
			if (this.isMatchingImageByUrl(url, imgSrc, imgInfo)) {
				console.log("图片匹配成功，开始更新宽度");

				// 从alt文本中移除现有的宽度标记
				const baseAltText = altText.replace(/\*\d+$/, "").trim();

				// 创建新的alt文本，添加宽度标记
				const newAltText = `${baseAltText}*${newWidth}`;
				const replacement = `![${newAltText}](${url})`;

				console.log(`替换: ${fullMatch} -> ${replacement}`);

				// 替换内容
				newContent = newContent.replace(fullMatch, replacement);
				updated = true;
				break; // 找到第一个匹配就停止
			}
		}

		// 如果没有找到匹配的 Markdown 格式，尝试匹配 Wiki 链接格式
		if (!updated) {
			console.log("未找到 Markdown 格式匹配，尝试 Wiki 链接格式");
			const wikiImageRegex = /!\[\[([^\]]+?)(?:\|[^\]]+)?\]\]/g;

			while ((match = wikiImageRegex.exec(content)) !== null) {
				const fullMatch = match[0];
				const filename = match[1];
				const baseFilename = filename.split("|")[0];

				console.log(
					`找到 Wiki 图片: ${fullMatch}, 文件名: ${baseFilename}`,
				);

				// 对于 Wiki 链接，通过文件名匹配
				if (this.isMatchingImageByFilename(baseFilename, imgInfo)) {
					console.log("Wiki 图片匹配成功，转换为 Markdown 格式");

					// 将 Wiki 格式转换为 Markdown 格式并添加宽度
					const replacement = `![${baseFilename}*${newWidth}](${imgSrc})`;

					console.log(`替换: ${fullMatch} -> ${replacement}`);

					newContent = newContent.replace(fullMatch, replacement);
					updated = true;
					break;
				}
			}
		}

		if (updated) {
			editor.setValue(newContent);
			new Notice(`图片大小已调整为 ${newWidth}px`);
		} else {
			console.log("未找到匹配的图片引用");
			new Notice("未能更新图片大小到 Markdown 源码");
		}
	}

	// 提取图片信息用于匹配
	private extractImageInfo(
		imgSrc: string,
	): { filename: string; domain: string; path: string } | null {
		console.log("提取图片信息，源URL:", imgSrc);

		try {
			const url = new URL(imgSrc);
			const pathname = url.pathname;
			const filename = pathname.split("/").pop() || "";

			const result = {
				filename: filename.split("?")[0], // 去掉查询参数
				domain: url.hostname,
				path: imgSrc, // 保存完整的原始URL用于精确匹配
			};

			console.log("URL解析结果:", result);
			return result;
		} catch (e) {
			console.log("URL解析失败，尝试提取文件名");
			// 如果不是完整 URL，尝试提取文件名
			const filename = imgSrc.split("/").pop()?.split("?")[0] || "";
			const result = filename
				? { filename, domain: "", path: imgSrc }
				: null;
			console.log("文件名提取结果:", result);
			return result;
		}
	}

	// 检查图片匹配
	// 通过URL匹配图片
	private isMatchingImageByUrl(
		markdownUrl: string,
		imgSrc: string,
		imgInfo: { filename: string; domain: string; path: string },
	): boolean {
		console.log("URL匹配检查:", { markdownUrl, imgSrc });

		// 直接URL比较
		if (markdownUrl === imgSrc) {
			console.log("URL直接匹配");
			return true;
		}

		// 对于远程URL，进行更精确的匹配
		if (markdownUrl.startsWith("http") && imgSrc.startsWith("http")) {
			try {
				const markdownUrlObj = new URL(markdownUrl);
				const imgSrcObj = new URL(imgSrc);

				// 比较域名和路径（忽略查询参数）
				if (
					markdownUrlObj.hostname === imgSrcObj.hostname &&
					markdownUrlObj.pathname === imgSrcObj.pathname
				) {
					console.log("URL域名和路径匹配");
					return true;
				}

				// 比较文件名
				const markdownFilename = this.extractFilenameFromUrl(
					markdownUrlObj.pathname,
				);
				const imgFilename = this.extractFilenameFromUrl(
					imgSrcObj.pathname,
				);

				if (this.compareFilenames(markdownFilename, imgFilename)) {
					console.log("URL文件名匹配");
					return true;
				}
			} catch (e) {
				console.log("URL解析失败:", e);
			}
		}

		// 检查文件名匹配
		if (imgInfo.filename && markdownUrl.includes(imgInfo.filename)) {
			console.log("URL包含文件名匹配");
			return true;
		}

		console.log("URL匹配失败");
		return false;
	}

	// 通过文件名匹配图片（用于Wiki链接）
	private isMatchingImageByFilename(
		markdownFilename: string,
		imgInfo: { filename: string; domain: string; path: string },
	): boolean {
		console.log("文件名匹配检查:", {
			markdownFilename,
			imgInfoFilename: imgInfo.filename,
		});

		if (!markdownFilename || !imgInfo.filename) {
			return false;
		}

		// 使用compareFilenames方法进行比较
		const result = this.compareFilenames(
			markdownFilename,
			imgInfo.filename,
		);
		console.log("文件名匹配结果:", result);
		return result;
	}

	// 从URL路径中提取文件名，处理URL编码
	private extractFilenameFromUrl(pathname: string): string {
		try {
			const filename = pathname.split("/").pop() || "";
			// 解码URL编码的文件名
			return decodeURIComponent(filename);
		} catch (e) {
			// 如果解码失败，返回原始文件名
			return pathname.split("/").pop() || "";
		}
	}

	// 比较两个文件名，考虑各种编码和格式差异
	private compareFilenames(filename1: string, filename2: string): boolean {
		if (!filename1 || !filename2) return false;

		console.log("比较文件名:", { filename1, filename2 });

		// 直接比较
		if (filename1 === filename2) {
			console.log("直接匹配");
			return true;
		}

		// 移除扩展名后比较
		const name1 = filename1.replace(/\.[^.]*$/, "");
		const name2 = filename2.replace(/\.[^.]*$/, "");
		if (name1 === name2) {
			console.log("无扩展名匹配");
			return true;
		}

		// 处理时间戳前缀（如：1770648740803-头像全身.png）
		const cleanName1 = name1.replace(/^\d+-/, "");
		const cleanName2 = name2.replace(/^\d+-/, "");
		if (cleanName1 === cleanName2) {
			console.log("清理时间戳后匹配");
			return true;
		}

		// URL编码比较
		try {
			const encoded1 = encodeURIComponent(filename1);
			const encoded2 = encodeURIComponent(filename2);
			if (encoded1 === encoded2) {
				console.log("编码后匹配");
				return true;
			}

			const decoded1 = decodeURIComponent(filename1);
			const decoded2 = decodeURIComponent(filename2);
			if (decoded1 === decoded2) {
				console.log("解码后匹配");
				return true;
			}

			// 比较清理时间戳后的编码/解码版本
			const cleanDecoded1 = decoded1
				.replace(/^\d+-/, "")
				.replace(/\.[^.]*$/, "");
			const cleanDecoded2 = decoded2
				.replace(/^\d+-/, "")
				.replace(/\.[^.]*$/, "");
			if (cleanDecoded1 === cleanDecoded2) {
				console.log("清理时间戳解码后匹配");
				return true;
			}
		} catch (e) {
			// 编码解码失败，忽略
			console.log("编码解码失败");
		}

		console.log("所有比较都失败");
		return false;
	}
}

//#endregion

class ImgurSettingTab extends PluginSettingTab {
	plugin: ImgurPlugin;
	private initUploader: () => Promise<void>;

	constructor(
		app: App,
		plugin: ImgurPlugin,
		initUploader: () => Promise<void>,
	) {
		super(app, plugin);
		this.plugin = plugin;
		this.initUploader = initUploader;
	}

	display(): void {
		const { containerEl } = this;
		containerEl.empty();

		const debouncedInit = this.debounce(async () => {
			await this.initUploader();
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

		// 添加测试上传按钮
		new Setting(containerEl)
			.setName("测试上传")
			.setDesc("测试COS连接和上传功能")
			.addButton((button) => {
				button.setButtonText("测试连接").onClick(async () => {
					if (!this.plugin.uploader) {
						new Notice("请先配置COS设置");
						return;
					}

					console.log("开始手动测试COS连接...");
					const result = await this.plugin.uploader.testConnection();
					if (result) {
						new Notice("COS连接测试成功！");
					} else {
						new Notice("COS连接测试失败，请检查控制台日志");
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
		console.log("COSUploader构造函数被调用，设置:", {
			hasSecretId: !!settings.secretId,
			hasSecretKey: !!settings.secretKey,
			bucket: settings.bucket,
			region: settings.region,
			prefix: settings.prefix,
			expiration: settings.expiration,
		});

		this.settings = settings;
		this.urlCache = new Map();

		if (!settings.secretId || !settings.secretKey) {
			throw new Error("请先配置腾讯云 SecretId 和 SecretKey");
		}

		try {
			console.log("开始创建COS实例...");
			this.cos = new COS({
				SecretId: settings.secretId,
				SecretKey: settings.secretKey,
				Protocol: "https:",
			});
			console.log("COS实例创建成功");
		} catch (error) {
			console.error("COS实例创建失败:", error);
			throw error;
		}
	}

	public cleanup() {
		if (this.updateInterval) {
			clearInterval(this.updateInterval);
			this.updateInterval = null;
		}
	}

	// 验证COS配置
	validateConfig(): { valid: boolean; errors: string[] } {
		const errors: string[] = [];

		if (!this.settings.secretId) {
			errors.push("缺少 Secret Id");
		}

		if (!this.settings.secretKey) {
			errors.push("缺少 Secret Key");
		}

		if (!this.settings.bucket) {
			errors.push("缺少存储桶名称");
		} else {
			// 检查存储桶名称格式
			const bucketRegex = /^[a-z0-9][a-z0-9-]*[a-z0-9]$/;
			if (!bucketRegex.test(this.settings.bucket.split("-")[0])) {
				errors.push("存储桶名称格式不正确");
			}
		}

		if (!this.settings.region) {
			errors.push("缺少地域信息");
		}

		console.log("COS配置验证结果:", {
			valid: errors.length === 0,
			errors,
			config: {
				secretId: this.settings.secretId
					? `${this.settings.secretId.substring(0, 8)}...`
					: "未设置",
				secretKey: this.settings.secretKey
					? `${this.settings.secretKey.substring(0, 8)}...`
					: "未设置",
				bucket: this.settings.bucket || "未设置",
				region: this.settings.region || "未设置",
				prefix: this.settings.prefix || "无前缀",
			},
		});

		return {
			valid: errors.length === 0,
			errors,
		};
	}

	// 测试COS连接
	async testConnection(): Promise<boolean> {
		try {
			console.log("开始测试COS连接...");

			// 尝试列出存储桶内容来测试连接
			return new Promise((resolve) => {
				this.cos.getBucket(
					{
						Bucket: this.settings.bucket,
						Region: this.settings.region,
						MaxKeys: 1, // 只获取1个对象来测试
					},
					(err: COS.CosError | null, data: any) => {
						if (err) {
							console.error("COS连接测试失败:", err);
							console.error("错误详情:", {
								code: err.code,
								message: err.message,
								statusCode: err.statusCode,
							});
							resolve(false);
						} else {
							console.log("COS连接测试成功:", data);
							resolve(true);
						}
					},
				);
			});
		} catch (error) {
			console.error("COS连接测试异常:", error);
			return false;
		}
	}
	async uploadFile(
		file: File,
		backupCallback?: (fileName: string) => Promise<void>,
	): Promise<string> {
		if (!this.settings.bucket || !this.settings.region) {
			throw new Error("请先配置存储桶和地域信息");
		}

		console.log("开始上传文件:", file.name, "大小:", file.size, "bytes");
		console.log("存储桶配置:", {
			bucket: this.settings.bucket,
			region: this.settings.region,
			prefix: this.settings.prefix,
		});

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

		console.log("上传路径:", fullPath);

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
						console.error("错误详情:", {
							code: err.code,
							message: err.message,
							statusCode: err.statusCode,
						});
						reject(err);
						return;
					}

					console.log("上传成功，响应数据:", data);

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

						console.log("开始获取签名URL...");
						const url = await this.getSignedUrl(fullPath);
						console.log("获取到签名URL:", url);

						this.urlCache.set(fullPath, url);
						resolve(url);
					} catch (error) {
						console.error("获取签名URL失败:", error);
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
		console.log("获取签名URL参数:", {
			fileName,
			prefix,
			expires: expiration,
			bucket: this.settings.bucket,
			region: this.settings.region,
		});

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
						console.error("获取签名URL错误:", err);
						reject(err);
						return;
					}

					const finalUrl =
						data.Url +
						(data.Url.indexOf("?") > -1 ? "&" : "?") +
						"response-content-disposition=inline";

					console.log("签名URL生成成功:", finalUrl);
					resolve(finalUrl);
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
