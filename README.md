![banner](/images/banner.png)

# 腾讯云 COS 图床插件

这是一个用于 Obsidian 的图片上传插件，可以将笔记中的图片自动上传至腾讯云 COS 对象存储，实现图片的云端存储和管理。

## 功能特点

-   支持拖拽上传图片
-   支持复制粘贴上传图片
-   支持右键菜单批量上传笔记中的本地图片
-   支持图片有效期设置，右键刷新图片有效期
-   自动替换本地图片链接为云端链接
-   上传完成后自动删除本地图片文件
-   支持存储桶地域选择
-   支持自定义存储路径前缀
-   支持图片格式（PNG、JPG、JPEG、GIF、SVG、WebP）

## 使用前准备

1. 注册腾讯云账号并开通 COS 服务

![开通 COS 服务](./images/open-cos.png) 2. 创建存储桶，记录存储桶名称和所在地域 3. 获取 SecretId 和 SecretKey

-   访问 [腾讯云控制台](https://console.cloud.tencent.com/)
-   进入 "访问密钥" -> [API 密钥管理](https://console.cloud.tencent.com/cam/capi)
-   创建或获取 SecretId 和 SecretKey

![获取密钥](./images/get-secret.png)

## 跨域访问 CORS 设置（注意）

> 复制到**来源 Origin** 的输入框内

```shell
app://obsidian.md
```
![跨域访问 CORS 设置1](./images/CORS-1.png)
![跨域访问 CORS 设置2](./images/CORS-2.png)

> ❗❗❗ **注意想在手机上使用需要把 `app://obsidian.md` 改成 `*`**

## 电脑端安装方法

1. 打开 Obsidian 设置
2. 进入 "第三方插件" -> "浏览"
3. 搜索 "Obsidian Imgur Plugin"
4. 点击安装并启用插件

![启用插件](./images/active.png)

## 配置说明

1. 进入插件设置页面
2. 填写以下信息：
    - SecretId：腾讯云 API 密钥 ID
    - SecretKey：腾讯云 API 密钥 Key
    - Bucket：存储桶名称（例如：my-bucket-1250000000）
    - Region：选择你开启存储桶所在地域
    - 存储路径前缀：文件在 COS 中的存储路径（例如：images）
  
> 存储路径前缀说明

比如你设置 `img`

![存储路径前缀说明1](./images/prefix-1.png)

那你的 COS 的图片就会上传到 `/img` 文件夹下

![存储路径前缀说明1](./images/prefix-2.png)

## 使用方法

### 方式一：拖拽上传

-   直接将图片文件拖拽到编辑器中
-   插件会自动上传图片并插入云端链接

### 方式二：复制粘贴

-   复制图片后，直接在编辑器中粘贴
-   插件会自动上传图片并插入云端链接

### 方式三：右键菜单批量上传

1. 在文件列表中右键点击 Markdown 文件
2. 选择 "上传图片到腾讯云 COS"
3. 插件会自动识别并上传文件中的所有本地图片，支持任意位置的图片文件

## 操作预览

![操作预览](./images/preview.gif)

## 注意事项

1. 首次使用请确保已正确配置腾讯云 COS 相关信息
2. 上传前请确保网络连接正常
3. 建议定期检查存储桶用量，避免超出配额
4. 请妥善保管 SecretId 和 SecretKey，不要泄露给他人
5. 存储路径前缀**不要**以斜杠开头或结尾

## 常见问题

1. **上传失败怎么办？**
    - 检查网络连接
    - 验证配置信息是否正确
    - 查看控制台错误信息

2. **如何组织云端文件结构？**
    - 使用存储路径前缀功能
    - 可以根据不同类型设置不同的前缀
    - 例如：blog/images、notes/attachments 等

## 支持与反馈

如果您在使用过程中遇到任何问题，或有功能建议，请通过以下方式反馈：

-   在 GitHub 上提交 Issue
-   发送邮件至：[15919854639@163.com]

## 许可证

本项目采用 MIT 许可证。详见 [LICENSE](LICENSE) 文件。

Copyright (c) 2024 bobostudio
