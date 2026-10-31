# Crok

Your funny discord bot by Grok

指定チャンネルでのAIメンション応答はEmbedで表示します。長い返答は複数メッセージに分割します。

## 音楽再生（YouTube / SoundCloud）

通常のボイスチャンネルに参加して `!play 曲のURL` を実行すると、Botが参加して再生します。
複数回実行するとサーバーごとのキューに順番に追加します。待機キューの上限は50曲です。
操作結果・キュー・エラーは枠付きのEmbedで表示します。
再生開始のEmbedには曲名、サムネイル（取得できる場合）、長さ、音源、リクエストした人、VC、待機曲数を表示します。

| コマンド    | 動作                                         |
| ----------- | -------------------------------------------- |
| `!play ...` | YouTube・SoundCloudの単曲URLを追加・再生     |
| `!pause`    | 一時停止                                     |
| `!resume`   | 再開                                         |
| `!skip`     | 読み込み中・再生中の曲をスキップ             |
| `!stop`     | 再生を停止し、待機キューを消去（VCには残る） |
| `!queue`    | 現在の曲と待機キューの先頭10曲を表示         |
| `/leave`    | 再生停止・キュー消去後にVCから退出           |

YouTubeの通常URL・`youtu.be`・Shorts・YouTube Music、SoundCloudの単曲URL・公式共有短縮URLに対応します。
動画ID付きのYouTubeプレイリストURLは、その動画1本だけを再生します。
プレイリスト全体、SoundCloudのセット、ライブ配信、曲名検索、ステージチャンネルには対応していません。
再起動するとキューは消去されます。非公開・地域制限・ログイン必須などの音源は取得できない場合があります。

### セットアップ

Node.js 24系とYarnを用意して依存関係をインストールし、音源取得用の [yt-dlp](https://github.com/yt-dlp/yt-dlp#installation) を追加してください。

```sh
yarn install
# macOS
brew install yt-dlp
# Python環境を使う場合は、代わりに以下でインストールできます
# python3 -m pip install -U 'yt-dlp[default]'
```

YouTubeの完全な対応には最新のyt-dlpと`yt-dlp-ejs`が必要です。
公式実行ファイルまたは`yt-dlp[default]`を使い、既存のインストールも更新してください。
JavaScriptランタイムにはBotを実行しているNode.jsを明示的に指定します。
音声変換は依存関係に含まれる`ffmpeg-static`を使い、音源をOgg/Opusへ変換しながら再生します。
追加のLavalinkサーバーやAPIキーは不要です。

`.env`にDiscordトークンを設定します。`yt-dlp`がPATH上にない場合だけ`YT_DLP_PATH`も設定してください。

```dotenv
DISCORD_TOKEN=your_discord_bot_token
# YT_DLP_PATH=/absolute/path/to/yt-dlp
```

```sh
yt-dlp --version
yarn start
```

音楽は通常のテキストメッセージで操作します。VCの「接続」「発言」とテキストチャンネルの「メッセージを送信」「埋め込みリンク」権限が必要です。
Discord Developer PortalでMessage Content Intentを有効にしてください。
`/join`・`/leave`・`/random`は引き続きスラッシュコマンドです。
キュー表示以外の操作はBotと同じVCにいるユーザーに限定しています。
音楽の読み込み・再生・一時停止中はVC自動追従、ランダム効果音、シーケンサーを抑制します。
最後の人が退出・移動すると音楽を停止してVCから退出します。

### 検査

```sh
yarn test
yarn check:music
```

`check:music`はtsxで実行するオフライン検査です。音源取得の応答をローカルのテスト用実行ファイルで置き換え、
実際のFFmpegによるOgg/Opus変換とDiscord音声リソースの読み込みを検査します。
外部サービスからの取得とDiscordでの実再生は、有効なURLとBotを使って別途確認してください。
