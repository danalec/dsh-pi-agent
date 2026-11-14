# dsh-pi-loop

[English](README.md) | [中文](README.zh.md) | [Português (BR)](README.pt-BR.md) | 日本語 | [Español](README.es.md)

> **Note:** this translation follows an older revision of the README; the canonical text is [README.md](README.md).

[Pi coding agent](https://github.com/earendil-works/pi)（[`@earendil-works/pi-coding-agent`](https://www.npmjs.com/package/@earendil-works/pi-coding-agent)）を [DeepSeek Harness](https://github.com/deepseek-ai/deepseek-harness)（[`@deepseek-ai/dsh`](https://www.npmjs.com/package/@deepseek-ai/dsh)）の中で agent loop として動かす DSH `Agent` プラグインです。ヘッドレスの `pi --mode rpc` 子プロセスを駆動するため、DSH のフロントエンド（セッションログ、hooks、プリセット、web UI）は一切変更せずに動きます。

> **こんな探apezではありませんか？**
> - *「DeepSeek Harness / DSH の中で pi をどう使うの？」* — ここがまさにその場所になります。
> - *「DSH の agent-loop を pi coding agent の loop に差し替えたい」* — 本プラグインはファクトリを `pi --mode rpc` 子プロセスに置き換えます。
> - *「pi を web UI / ブラウザフロントエンドで動かしたい」* — dsh-pi-loop と公式 DSH web app の組み合わせで、pi は完全な web インターフェースを手にします。セッション永続化、hooks、プリセット、モデル選択すべて対応です。
> - *「DSH の中で最小限でクリーンなプロンプトを使いたい」* — pi エンジンは約 300 トークンのシステムプロンプトと 4 つのツールを維持します。DSH のプロンプト組み立てはモデルに一切届きません。プロンプト注入ゼロです。
> - *「DSH の中で Claude Code / Codex のサブエージェントを使いたい」* — DSH はそれらをネイティブにサポートしています。本プラグインは同じ方式で pi をエンジン選択肢に追加します。

```
DSH フロントエンド（セッション、hooks、プリセット、SQLite 永続化、web UI）
        │
dsh-pi-loop  （本プラグイン: AgentFactory + イベント変換 + 履歴ハンドオフ）
        │  spawn + stdio 上の JSONL
        │  コマンド: set_model / prompt / steer / abort
        ▼
pi --mode rpc --session <再構築された履歴>   （Pi の agent loop、そのもの）
```

create/resume のたびに本プラグインは DSH の永続イベントログから Pi セッションファイルを再構築し、`--session` 付きで子プロセスを起動します。したがって子のコンテキストウィンドウには最初から会話全体が 들어られており、切り替え前に DSH ネイティブ loop で実行されたターンを含みます（[セッション引き継ぎ](#セッション引き継ぎ)を参照）。

## なぜ

Pi はミニマルな harness です。約 300 トークンのシステムプロンプト、4 つのツール（`read`/`bash`/`edit`/`write`）、そしてセッション途中の注入ゼロ。DSH（[DeepSeek Harness](https://github.com/deepseek-ai/deepseek-harness)）はプラグイン型プラットフォームで、耐久セッション、ポリシー、承認チェーン、完全なプロンプト組み立てレジストリを持ちます。

本プラグインは両方を同時に手に入らせます。**Pi のクリーンなエンジンの外側に DSH のエンジニアリングシェルをかぶせる**。プラグインが有効なとき、モデルは同じ作業ディレクトリで `pi` を直接動かしたときとまったく同じものを見ます。追加のプロンプトセクションも、追加のツールも、隠されたリマインダーもありません。DSH 自身のプロンプト組み立て（`dsh-system-prompt`）とツール面は、このファクトリが駆動するセッションでは完全にバイパスされます。

また、きれいな A/B 実験にもなります。フロントエンドもセッション形式も同じのまま、プラグインの on/off を切り替えて DSH ネイティブ loop と素の Pi loop を比較できます。

## 変わるものと変わらないもの

| レイヤ | 挙動 |
| --- | --- |
| システムプロンプト / ツール / コンテキスト | **そのまま** — 同じディレクトリで `pi` を動かしたときと同一（`AGENTS.md` などのコンテキストファイルは Pi 自身が読み込みます） |
| モデルルーティング | セッションごとに `set_model`。委譲されたサブエージェントが要求したモデルがファクトリの既定より優先されます。provider のないモデルは既定の provider を借ります — provider 欄がモデル id を受け取ることはありません。Pi が拒否したルートは、Pi の既定モデルで黙って実行されるのではなく、そのターンを明示的に失敗させます |
| ステアリング | DSH の `send(..., 'next-turn' \| 'next-step')` は Pi の `steer` に対応します — 実行中に指示を注入できます。指示は稼働中の loop にちょうど一度だけ配信され、Pi が一度も注入しなかったバッチは捨てずに復旧して独自のステップとして渡されます |
| キュー | フロントエンドのキュドックは `inbox` セッション投影を読みます。native loop が持つ投影ですが、Pi loop 自身が登録するため、キューされた項目とステアリングは見え続けます |
| セッション永続化 | DSH のセッションイベントが耐久的な唯一の事実源のままです。Pi セッションファイルは create/resume ごとにそこから再構築されるので、子は全履歴付きで起動します |。再構築はバイト予算（`contextBudgetBytes`、既定 1 MB）を守り、古いメッセージは native loop のコンパクトと同じように切り捨てられ、ツール結果は対応するツール呼び出しより長生きしないことが保証されます |
| 多クルモデル | フロントエンドの選択器で選んだモデルで動きます（`pinModel: false`）。DSH の provider 名と Pi の provider 名は同じなので、路由は繋換せずプロセスの場界を越えません；harness 自己の `deepseek-official` ルートは Pi の `deepseek` provider に映射されます。DSH プロファイルが声明するゲートウェイ（`tencent`、`bailian-tpp`）は Pi のモデル設定に同じエンドポイントが必要です —— `node tools/sync-pi-providers.mjs <profile>` が書きます |
| 承認 / 権限 | Pi のローカル信頼モデルが適用されます — Pi のツール呼び出しは DSH の承認チェーンを通りません |
| フォールバック | 本プラグインのエントリを無効化すると、DSH 自身の `dsh-agent-loop` が即座に再び有効になります |

## 境界マッピング

ブリッジは Pi の内部構造を DSH のターン / ステップモデルへ変換します。

| DSH | Pi |
| --- | --- |
| 1 ターン | 1 回の `prompt` コマンド（1 回の Pi 実行） |
| 1 ステップ | 1 つのアシスタントメッセージ（1 回のモデル呼び出しと、それが要求したツール実行） |
| ステップ境界 | Pi の `turn_end` イベント（アシスタントのターンが終了した時点） |
| next-step 入力 | Pi の `steer` コマンド（次の LLM 呼び出しの直前に配信） |

ターンは Pi が `agent_settled` を報告したときに閉じます。`agent_end` ではありません — そちらは低レベルの 1 回の実行を終了するだけで、リトライ、圧縮回復、キュー内の作業は依然として続く可能性があります。

## DSH エージェントフック

本プラグインは、フロントエンドとポリシーチェーンが依存するエージェント 이벤トを実装しています。

| イベント | 挙動 |
| --- | --- |
| `agent/status` | `idle` ⇄ `running`、すべての遷移でミラーリングされます |
| `agent/inbox/inserted` / `claimed` / `discarded` | 保留中の入力はステップに入った時点で **claim** されます（キャンセルとして記録されることはありません） |
| `agent/pre-step` | 各ステップ前にディスパッチされます。`reject` はターンをブロックし（`turn/end` の理由は `blocked`）、Pi には prompt が送られません |
| `agent/turn-stopping` | ターンの停止境界でディスパッチされます。そこで注入されたステアリングは同じターン内でさらに 1 ステップを実行します |
| `agent/session-start` | 新規セッションでは `source: 'startup'`、永続化されたセッションの再開では `'resume'` |
| `agent/error` | 生存境界で報告されます。ターンはエラー理由付きで閉じられます |

2 つのエージェントイベントは **発火しません**。そのセマンティクスがプロセス境界を越えて守れないためです: `agent/request` と `agent/request-error` はモデル呼び出しそのものを包みますが、モデル呼び出しは Pi 子プロセス内部で起きるからです。モデル呼び出しに影響させたいリスナーは、Pi 自身の拡張機能を使う必要があります。

## セッション引き継ぎ

セッションが Pi の下で生まれなくても、Pi に駆動させることができます。DSH 自身の loop（あるいは以前の Pi 子プロセス）下でターンを実行済みのセッションを本プラグイン経由で再開すると、会話は続きから再開されます。DSH のイベントログ（`user/message`、`assistant/message`、`tool/call`、`tool/result`）が Pi セッションファイルに変換され、新しい子が `--session` でそれを読み込むため、履歴全体 — 以前の DSH ネイティブ turn も含めて — がそのコンテキストウィンドウに入ります。

- DSH は引き続き唯一の事実源です。Pi ファイルは再構築されたスナップショットであり、create/resume ごとに再生成されます（ずれも重複もなし）。
- DSH のメッセージブロックはネイティブに対応します: `text` → `text`、`reasoning` → `thinking`、`tool-call` → `toolCall`（arguments を再解析）、`tool/result` → `toolResult`（ツール名は呼び出しログから復元）。
- image ブロックは現状スキップされます（attachment 参照には実行時の添付サービスが必要）。テキスト履歴がコンテキストを担います。
- 再構築されたファイルは安定したセッション ID を保ちます（DSH セッション ID から導出）。引き継ぎは別セッションではなく継続です。
- セッションファイルは監査用に `~/.dsh/pi-sessions/<session-id>.jsonl` に配置されます。

```
DSH 標準モード:   ターン 1 ── ターン 2 ── ターン 3        （ネイティブ loop）
                                        │
        本プラグイン経由で再開 ──────────┘  DSH ログから Pi セッションを再構築
                                        ▼
pi モード:         [履歴ロード済み] ── ターン 4 ── …  （Pi loop、コンテキスト完全）
```

## Pi 上のサブエージェント

メイン loop とは独立した設定: provider プラグインは独自の profile 行であり、2 つのエンジンはそれぞれ独立に切り替えられます — メイン loop は `pi` ＋ネイティブサブエージェント、メイン loop はネイティブ＋`pi` サブエージェント、あるいは両方 `pi` でもかまいません。

```yaml
# Pi エンジンでのサブエージェント委譲（メイン loop の行とは独立）:
- insert:
    - id: subagent-pi
      name: 'dsh-pi-loop/subagent'
      config:
        providerName: pi
        piPath: 'pi'                  # 既定は PATH からの探索
        model: 'provider/model'      # 省略すると pi の設定済み既定モデル
        timeoutMs: 600000

    - id: tool-subagent
      name: '@deepseek-ai/dsh-tool-subagent'
      config:
        provider: pi                  # 'spawn'/'fork' なら DSH ネイティブの子
        toolName: subagent
        backgroundMode: one-shot
        maxDepth: 'provider-managed'
```

各委譲は親セッションの作業ディレクトリで新しい `pi -p <task>` を spawn します。素の Pi システムプロンプト、自分自身のツール、自分自身の `AGENTS.md` 探索。親の会話・ペルソナ・ツール面から何もプロセス境界を越えません — `inheritsParentContext: false`、プロンプトの衝突ゼロ。

## 必要条件

- Node.js ≥ 20
- `PATH` 上の [`pi`](https://www.npmjs.com/package/@earendil-works/pi-coding-agent)（`npm i -g @earendil-works/pi-coding-agent`）（または `piPath` を指定）
- `sessions` と `agents` サービスを公開する profile を持つ [DSH](https://www.npmjs.com/package/@deepseek-ai/dsh)（`npm i -g @deepseek-ai/dsh`）— 標準のフロントエンド構成
- ピア依存: `@deepseek-ai/cordis`、`@deepseek-ai/dsh-agent`、`@deepseek-ai/dsh-llm`、`@deepseek-ai/dsh-scope`、`@deepseek-ai/dsh-session`

## インストール

```bash
# Link the working tree: the profile always runs your checkout (rebuild, then
# restart DSH). This is the development setup.
dsh plugin --profile desktop add link:/path/to/dsh-pi-loop

# Or install a copy of the directory (what `npm pack` would produce).
dsh plugin --profile desktop add file:/path/to/dsh-pi-loop
```

このパッケージは npm レジストリにはありません — 以前の `dsh-pi-loop` の
公開は取り消されています — そのため GitHub から直接インストールして
ください。任意の DSH profile からマウントできます（Web 用の完成 profile は
[dsh-pi](https://github.com/Micheleww/dsh-pi) を参照）。

各 release にはパッケージ済みの tarball も付属します:
[github.com/danalec/dsh-pi-loop/releases](https://github.com/danalec/dsh-pi-loop/releases)。

関連: [pi エコシステム](https://github.com/earendil-works/pi) には [pi-gui](https://github.com/minghinmatthewlam/pi-gui)、[pi-hosts](https://github.com/hunvreus/pi-hosts)、[pi-zentui](https://www.npmjs.com/package/pi-zentui) もあります。DSH はサブエージェントエンジンとして [Claude Code](https://www.npmjs.com/package/@deepseek-ai/dsh-subagent-claude-code) と [Codex](https://www.npmjs.com/package/@deepseek-ai/dsh-subagent-codex) をネイティブにブリッジします — dsh-pi-loop は同じ形で **pi** をエンジンおよび loop の選択肢に追加します。

## 使い方

profile パッチ層（`cordis.patch.yml`）でマウントします:

```yaml
# すべての新規セッションで Pi loop を使う。
- insert:
    - id: pi-loop
      name: 'dsh-pi-loop'
      config:
        piPath: 'pi'                      # または絶対パス
        cwd: '/path/to/your/project'      # Pi セッションの作業ディレクトリ
        model: 'anthropic/claude-sonnet-4-5'  # provider/model ルート
        debug: false

# DSH 自身の loop に戻す: このエントリを無効化して agent-loop を再度有効に。
# - id: pi-loop
#   disabled: true
```

### 設定

| キー | 型 | 既定値 | 説明 |
| --- | --- | --- | --- |
| `piPath` | `string` | `'pi'` | Pi の実行ファイル。`PATH` から解決されます |
| `cwd` | `string` | `process.cwd()` | Pi セッションの作業ディレクトリ |
| `model` | `string` | — | Pi のモデルルート（`provider/model`） |
| `debug` | `boolean` | `false` | プロトコル診断を `<tmpdir>/dsh-pi-loop.log` へ追記します |

## プラットフォームメモ

- **Windows**: Pi はコマンド shim として配布されます。本プラグインは shim（`.exe`/`.com`/`.cmd`/`.bat`）を解決し、`.cmd`/`.bat` はすべての引数を引用符で囲んで `cmd.exe` 経由で起動するため、`pi.cmd` はそのまま動きます。shim が `PATH` にない場合は `piPath` で指定してください。
- **POSIX**: shim は実行スクリプトなので直接 spawn されます。
- 診断ファイルはプラットフォームの一時ディレクトリ（`os.tmpdir()`）にあり、どのプラットフォームでも書き込み可能です。

## デバッグ

`debug: true` を設定すると、すべての RPC コマンド、イベント、子プロセスの終了、ファクトリのライフサイクル手順が `<tmpdir>/dsh-pi-loop.log`（Windows では `%TEMP%`、それ以外では `/tmp`）へ追記されます。Pi 自身の stderr も同じログへ転送されます。`debug` が off のときは sink を一切インストールしません — プロトコル層は診断を整形せず、ディスクにも触れません。

## 開発

```bash
npm install
npm run typecheck   # tsc --noEmit
npm test            # ビルドしてから node:test スイートを実行
```

テストランナーには glob サポートのため Node ≥ 21 が必要です。ライブラリ本体は
Node ≥ 20.11 で動作します。

スイートは履歴再構築（ブロックマッピング、停止理由、セッション ID）、Pi イベント変換（ツール結果、ストリーミングされる tool-call ID、確定、キャンセル、inbox の claim）、そして実際の JSONL プロトコルを話す偽の `pi` バイナリに対する RPC クライアントをカバーしています。

## ライセンス

2 つのライセンスから選択できます: **MIT** または **Apache-2.0**（`MIT OR Apache-2.0`）。どちらも単独で完全かつ無料のオープンソースライセンスです。

企業での再配布には Apache-2.0 が適しています。广泛な著作権許諾に加えて特許許諾（3 節）が得られ、著作権者に対して特許訴訟を提起した場合はその許諾が終了します。MIT は 2 つのうちより寛容な方で、条文が短く、特許許諾の明文規定も NOTICE ファイルもありません。

サポート、保証、indemnity はどちらのライセンスでも許諾されません。著作権者との個別契約の対象であり、第 3 のライセンス選択肢ではありません。

全文: [`LICENSE`](LICENSE)、[`LICENSE-MIT`](LICENSE-MIT)、[`LICENSE-APACHE`](LICENSE-APACHE)。
