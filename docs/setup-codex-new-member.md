# Discord MCP セットアップ指示書（Codex / macOS・Windows対応）

このファイルをCodexに添付し、次のように依頼してください。

> この指示書に従ってDiscord MCPをセットアップしてください。

Codexは以下の手順を順番に実行してください。macOSとWindowsの両方に対応し、ユーザーが手作業で設定ファイルを編集しなくて済むように進めてください。

---

## Codexへの指示

### 1. OSとCodex CLIを確認

実行環境がmacOSかWindowsかを確認し、次のコマンドが使えるか確認する。

```bash
codex --version
```

- macOSではTerminalまたは現在利用できるシェルで実行する。
- WindowsではPowerShellで実行する。
- `codex` が見つからない場合は、Codexアプリが最新版か確認するようユーザーへ案内する。利用可能ならCodexアプリに同梱されたCLIを使う。
- CLIを利用できない場合だけ「4. CLIを利用できない場合」へ進む。

### 2. 既存のDiscord MCP設定を確認

```bash
codex mcp get discord
```

- 設定がなくエラーになる場合は、そのまま手順3へ進む。
- URLが `https://lp.shokunin-san.xyz/mcp` で、`enabled: true`、`transport: streamable_http` なら再登録せず手順5へ進む。
- `discord` という名前で別のURLまたは別の起動コマンドが登録されている場合は、勝手に上書きせず、ユーザーへ既存設定を置き換えてよいか確認する。
- 置き換えの許可を得た場合のみ、次を実行してから手順3へ進む。

```bash
codex mcp remove discord
```

### 3. 共有Discord MCPを登録

macOS・Windowsのどちらでも次のコマンドを実行する。

```bash
codex mcp add discord --url https://lp.shokunin-san.xyz/mcp
```

このMCPはOAuthを使用しないため、`codex mcp login discord` は実行しない。

### 4. CLIを利用できない場合

CLIがどうしても利用できない場合に限り、Codexのユーザー設定ファイルを編集する。

- macOS: `~/.codex/config.toml`
- Windows: `%USERPROFILE%\.codex\config.toml`

既存設定を消さず、同名の設定がないことを確認して次を追加する。

```toml
[mcp_servers.discord]
url = "https://lp.shokunin-san.xyz/mcp"
```

`[mcp_servers.discord]` が既に存在する場合は重複して追加しない。別URLが設定されている場合は、変更前にユーザーへ確認する。

### 5. Discordで表示する名前を確認

ユーザーへ次の1点を質問する。

> Discordへ投稿するときに表示する名前を教えてください（例：千葉）。

回答後、Codexのグローバル指示ファイルを確認する。

- macOS: `~/.codex/AGENTS.md`
- Windows: `%USERPROFILE%\.codex\AGENTS.md`

ファイルがなければ作成する。既存内容は消さず、同じルールがなければ以下を追記する。`名前` はユーザーの回答に置き換える。

```markdown
## Discord送信ルール

- Discord MCPでメッセージ送信、返信、ファイル送信、スレッド作成を行うときは、利用可能な場合は必ず `sender_name` に「名前」を指定する。
- `sender_name` を指定した場合、本文へ `【名前】` を重ねて付けない。
- `sender_name` を指定できないDiscord送信ツールでは、本文の冒頭に必ず `【名前】` を付ける。
```

### 6. 登録結果を確認

CLIを利用できる場合は次を実行する。

```bash
codex mcp get discord
```

次の内容を確認する。

- `enabled: true`
- `transport: streamable_http`
- `url: https://lp.shokunin-san.xyz/mcp`

設定直後のタスクには新しいMCPが読み込まれない場合がある。その場合は、ユーザーへCodexアプリを再起動するか、新しいタスクを開始するよう案内する。

### 7. 新しいタスクで動作確認

再起動または新しいタスクの開始後、ユーザーに次の依頼を送ってもらう。

```text
Discordのチャンネル一覧を取得してください。
```

Discord MCPの `list-channels` が呼び出され、チャンネル一覧が返ればセットアップ完了。

投稿テストは実際にDiscordへメッセージを送るため、必ずユーザーの明示的な依頼を受けてから行う。

## 完了メッセージ

設定と確認が終わったら、次を表示する。

```text
✅ Discord MCPのCodexセットアップが完了しました！

利用例：
- 「Discordのチャンネル一覧を取得して」
- 「#generalの最新メッセージを5件読んで」
- 「#devに進捗報告を投稿して」
- 「○○さんにDMを送って」

設定URL: https://lp.shokunin-san.xyz/mcp
認証操作は不要です。

設定直後にDiscordツールが表示されない場合は、Codexアプリを再起動するか、新しいタスクを開始してください。
```

## 注意事項

- この共有MCP URLにはOAuth認証がない。URLを外部へ公開しない。
- Discordへの投稿、DM、編集、削除など外部状態を変える操作は、ユーザーの明示的な依頼を確認してから行う。
- 他のMCP設定や既存の `AGENTS.md` の内容を削除・上書きしない。
- Discord Bot TokenやVPSへのSSH接続情報は各メンバーのPCへ設定しない。
