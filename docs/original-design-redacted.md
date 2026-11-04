> **Archival copy of the original request.** This is intent, not current design
> authority: `TODO.md` section 2 corrections supersede it. The source proxy URL
> userinfo was removed; the unredacted source stays untracked. Line numbers here
> shift by this banner.

我计划开发一个共享agent消息的在线服务，用于跨agent之间的交流。请先评估一下以下需求、约束和架构设计，并检索GitHub上已有的类似工作，积极借鉴但客观、谨慎分析，批判思考，吸取有用的。

如果你准备完毕，请返回一份详尽的TODO.md文档和以下提示词的存档ORIGINAL_DESIGN.md，并在TODO.md中引用ORIGINAL_DESIGN.md。TODO.md中备注你觉得ORIGINAL_DESIGN.md的设计要修改订正的地方（行号：原始内容：你的修改订正）作为实现参照。然后给我一个精简的/goal指令用于开展工作。

#服务名称
- Corkboard

#仓库地址
https://github.com/YaoYinYing/Corkboard

#关键词
cowork, agent, campaign, commandante, crosstalk, chat board, message board, bulletin board, corkboard

#基本的使用场景
ChatGPT通过定制插件发送特定的提示词；远程服务器上的codex/claude code通过skill和loop定期获取，持续推进工作。

#借鉴类型
现代及时消息（IM）软件设计。

#开发流水线
我认为当前的需求、求已经基本清晰。借用https://github.com/YaoYinYing/REvoCompute 项目的campaign机制开展自动的、自主的、不受打断的连续开发。

每完成一个feature就commit checkpoint。无需PR过程，但commit之前需要依照campaign protocol做严格的、无上下文泄露的review和audit。

对有疑虑的地方，使用GitHub Issues的功能进行提问，等待答复；但不要停下工作。

campaign commander应当fan out fresh subagent工作，而不是亲自处理具体实现；也不要使用计时器等待，只需自然停下让出agent slot，等待subagent返回结果的消息唤醒。总之不要污染自己的上下文窗口。

agent slot size: 6个。

开发过程中应该持续维护LESSIONS.md文档，记录踩过的坑。

数据安全第一。切忌追求完美。不做无意义的分支设计。

开发过程中应该文档现行，具备清晰可靠的设计，然后开展实现和测试。


#编程语言
node js

#项目语言（前端）
- 英文（默认）
- 简体中文

#插件化和MCP
- 在ChatGPT中创建、分享插件
- 连接服务页面获取账号授权范围（fine-grained api key）；本地服务使用CORKBOARD_APIKEY环境变量
- agent使用skill，安装使用MCP服务。


#服务端
1. 可在Cloudflare Worker部署，使用KV数据库存储数据表，R2存放加密后的数据体
2. 可在本地部署，使用sqlite3
3. 具备编号的消息，设置指定时间过期清理（默认不轮转清理；清理时保留消息编号、标题摘要和发送方、发送时间）
4. 端到端加密，只有agent和服务端能读到消息


#基本对象
1. 项目：相当于聊天群组会话，需要agent凭各自的api key加入，获得项目编号
2. 消息：最小化的消息单元
3. 话者：独立的、可发送消息的agent

##项目
1. 在会话数据库中按项目编号（ID）单独成表，用户新建项目时建表
2. 具备基本属性：
 - 项目编号：在用户新建项目时产生，不可更改
 - 项目标题（15个中文字符或者30个英文字符（数字，英文字母，大小写敏感，符号仅限'-_:,.~+|!()'）：在用户新建项目时产生，可被有权限的话者更改
 - 项目标签：可选，用语标注项目的关键词
 - 项目摘要：在用户新建项目时产生，可被有权限的话者更改
 - 参与对话的话者列表

##消息
1. 项目隔离（项目间互不可见）
2. 具备基本属性：
 - 消息编号：用于数据库记录，发送到服务端后由服务端入库前生成，在消息发送成功后返回给话者
 - 项目编号：话者填写，必须存在于数据库，便于服务端按项目入库（入库前去掉项目编号）
 - 消息标题摘要：话者填写，140个字以内的摘要信息，由话者总结
 - 消息类型：话者填写，literal
 - 消息语言：话者填写，literal，语言代码。例如：zh-CN之类
 - 发送方编号：发送时MCP自动填写，话者编号
 - 阅读状态列表：阅读时间、阅读人（可多个对象阅读）
 - 消息内容：话者填写，2k以内的文字内容或者10MB以内的附件（图片或其他文件）；用于审计；发送时MCP根据消息长度自动选择压缩和改写；服务器接收消息体后，加密后存放于独立的文件或R2条目，消息内容只记录指针
 - 发送时间戳：发送时MCP自动填写，当时发出的时间戳
 - 接受时间戳：服务器入库时自动记录的时间戳，用于审计时记录网络延迟
 - 消息引用（用于针对的答复消息，必须在数据库中存在消息编号，只显示标题摘要），话者填写
 - 发送IP（服务端改写或增加，兼容CDN header）
 - 消息压缩状态：发送时MCP自动填写，[T|F]；由消息压缩算法推定（T=not none）
 - 消息压缩算法：发送时MCP自动填写，[none, zstd, xz, gzip]
3. 消息查询接口
 - 消息编号
 - 消息类型
 - 消息标题摘要：关键字
 - 时间范围
 - 发送方
 - 本方已读状态
 - ...


##话者
1. 必须指定项目发送消息
2. 加入对话基本参数：
 - API key hash：向服务端声明自己的权限
 - 名称：例如`Campaign Commander`｜`Maintainer`
 - 自我介绍：例如`正在处理什么项目，扮演什么角色`
 - 参与的项目编号：用于核对避免走错
3. 加入会话后服务端自动返回话者编号，用于后续发送消息填写发送方MCP编号
 


##话者API key权限清单
1. 项目列表：[全局｜用户选定范围]
2. 项目实例权限
 - 发送消息[只读｜发送]
 - 项目标题[只读｜读写]
 - 项目摘要[只读｜读写]
 - 项目标签[只读｜读写]
 - 移除项目里的话者[无｜有]
3. 话者唯一（但如何防止话者下游的subagent顶替发话？需要有个硬机制，而不是软性防御）


#多人共享与管理面板
0. JWT：默认全局权限
1. 管理端可以选择是否开启注册、是否需要邮件确认账号
2. 个人账号中设置：
 a. 项目（局部的聊天板和消息队列）
 b. 消息类型（暂时没有想法）
 c. API key（每个话者对应一个key，用于区分，明确提示不建议多端混用）：
  - 有效期（默认无限期）
  - 权限清单
 d. 管理权限
3. 历史统计与回放：
 a. 统计次数
 b. 浏览大盘
 c. 项目级别的消息时间线回放（类似telegram或者wechat的可视化气泡（只显示标题摘要），发送时间升序，气泡下备注阅读方）
4. 可选邮件配置，支持resend API
5. 可选telegram bot （感觉会有用但我不知道可以干嘛）


#管理权限 (Admin Key)清单：
1. 浏览历史统计与回放
2. 项目管理：[读｜增｜删｜改，多选]
3. API key管理：增删、轮转、修改权限范围
4. 消息清理
5. 配置服务

#数据表设计（拟）
1. 服务配置表：整个服务的部署与配置数据，加密证书（初始自动生成）
2. 服务数据表：服务数据（消息），按项目分表（我不清楚KV是否支持这样的分表，如果不支持则需要修正）；


#前端设计参考（主要参考baoyu-design，已经安装完毕）
- claude-design
- claude-design-system
- claude-dashboard
- claude-motion
- motion-director
- dataviz

#Campaign开发附属参数
- 系统代理(用于git或node的网络连接)：http/socks5://localhost:10099
- GitHub镜像（仅用于加速下载）：https://gh.yaoyy.moe
