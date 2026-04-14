# Discord MCP セットアップ指示書（新規メンバー向け）

このファイルをClaude Codeに読み込ませて「この指示に従ってセットアップして」と伝えてください。

---

## Claude Code への指示

以下の手順を順番に実行してください。

### 1. リモートMCPの登録

以下のコマンドでClaude CodeにDiscord MCPサーバーをリモート接続で登録する。

```bash
claude mcp add discord -s user --transport http https://lp.shokunin-san.xyz/mcp
```

> URLは既にリモートサーバーに設定済みなので、そのまま実行すること。

### 2. Claude Desktop への設定

ユーザーに「Claude Desktopも使っていますか？」と確認する。
使っている場合のみ、以下の設定ファイルを編集する。

**Mac:** `~/Library/Application Support/Claude/claude_desktop_config.json`
**Windows:** `%APPDATA%\Claude\claude_desktop_config.json`

ファイルが存在しない場合は新規作成する。既にファイルがある場合は `mcpServers` の中にマージする。

```json
{
  "mcpServers": {
    "discord": {
      "command": "npx",
      "args": [
        "mcp-remote",
        "https://lp.shokunin-san.xyz/mcp"
      ]
    }
  }
}
```

### 3. claude.ai Web版 / スマホアプリへの設定

ユーザーに「claude.ai（Web版やスマホアプリ）でも使いたいですか？」と確認する。
使いたい場合は以下の手順を案内する：

1. https://claude.ai/settings にアクセス
2. 左メニューの「**コネクタ**」を開く
3. 上部バナーの「**カスタマイズに移動**」をクリック
4. 「**カスタムコネクタを追加**」をクリック
5. 以下を入力（詳細設定は空欄でOK）：
   - **名前**: `Discord`
   - **URL**: `https://lp.shokunin-san.xyz/mcp`
6. 保存する
7. 同じアカウントでログインしていればスマホアプリにも自動反映される

### 4. CLAUDE.md にDiscord送信ルールを追記

ユーザーのホームディレクトリにある `~/.claude/CLAUDE.md`（なければ作成）に以下を追記する。
**【名前】の部分はユーザーに「Discordで表示する名前を教えてください」と聞くこと。**

```markdown
## Discord送信ルール
Discordにメッセージを送信する際は、必ずメッセージ冒頭に「【名前】」を付けること。
例: 【千葉】お疲れ様です。本日の進捗を共有します。
```

### 5. 動作確認

セットアップ完了後、以下を実行して動作確認する：

- 「Discordのサーバー一覧を教えて」と自分自身に聞いて、MCP toolが呼ばれるか確認する
- 正常にサーバー一覧が返ってきたらセットアップ完了と伝える
- Claude Desktopを設定した場合は「Claude Desktopも再起動してください」と伝える

### 完了メッセージ

すべて完了したら以下を表示する：

```
✅ Discord MCP セットアップ完了！

Claudeから以下のようなことができます：
- 「#generalの最新メッセージを読んで」
- 「#devに進捗報告を投稿して」
- 「Discordのチャンネル一覧を見せて」
- 「○○さんにDMを送って」

メッセージ送信時は自動で【あなたの名前】が冒頭に付きます。
何か問題があれば千葉までDMしてください。
```
