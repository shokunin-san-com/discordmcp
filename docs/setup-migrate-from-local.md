# Discord MCP セットアップ指示書（ローカルMCPからの切り替え）

既にローカルMCP（stdio型）を設定済みのメンバー向けです。
このファイルをClaude Codeに読み込ませて「この指示に従ってセットアップして」と伝えてください。

---

## Claude Code への指示

以下の手順を順番に実行してください。

### 1. 既存のローカルMCP設定を削除

```bash
claude mcp remove discord -s user
```

### 2. ローカルのdiscordmcpリポジトリを削除（任意）

```bash
rm -rf ~/discordmcp
```

> ユーザーに「ローカルにcloneしたdiscordmcpフォルダを削除してもよいですか？」と確認してから実行すること。

### 3. Claude Desktop のローカルMCP設定を削除

**Mac:** `~/Library/Application Support/Claude/claude_desktop_config.json`
**Windows:** `%APPDATA%\Claude\claude_desktop_config.json`

上記ファイルを開き、`mcpServers` 内の `"discord"` エントリを削除する。
ファイル内に他のMCPサーバー設定がある場合はそれらは残すこと。

### 4. リモートMCPを登録

**ユーザーに「千葉さんから受け取ったMCPサーバーのURLを貼ってください」と聞くこと。**

```bash
claude mcp add discord -s user --transport http https://lp.shokunin-san.xyz/mcp
```

### 5. Claude Desktop にリモートMCP設定を追加

`~/Library/Application Support/Claude/claude_desktop_config.json` の `mcpServers` に以下をマージする：

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

### 6. claude.ai Web版 / スマホアプリへの設定

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

### 7. CLAUDE.md のDiscord送信ルール確認

`~/.claude/CLAUDE.md` に以下のルールが既にあるか確認する。なければ追記する。
**【名前】はユーザーに確認すること。**

```markdown
## Discord送信ルール
Discordにメッセージを送信する際は、必ずメッセージ冒頭に「【名前】」を付けること。
例: 【千葉】お疲れ様です。本日の進捗を共有します。
```

### 8. 動作確認

- Claude Desktopを再起動する
- 「Discordのサーバー一覧を教えて」と聞いて、MCP toolが正常に呼ばれるか確認する
- 正常に動作したらセットアップ完了

### 完了メッセージ

すべて完了したら以下を表示する：

```
✅ Discord MCP リモート版への切り替え完了！

これまでのローカルMCP設定は削除済みです。
今後はリモートサーバー経由で接続されるため、ローカルにNode.jsやリポジトリは不要です。

claude.ai Web版・スマホアプリからも使えます：
- 「#generalの最新メッセージを読んで」
- 「#devに進捗報告を投稿して」
- 「○○さんにDMを送って」

何か問題があれば千葉までDMしてください。
```
