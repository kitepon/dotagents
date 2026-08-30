# gpt-connector macOS 非可視 cold launch 実測

- 出典:
  - https://chromedevtools.github.io/devtools-protocol/tot/Browser/
  - https://chromedevtools.github.io/devtools-protocol/tot/Target/
  - https://developer.apple.com/documentation/appkit/nswindow/setframe(_:display:)
- 取得日: 2026-07-14
- 確度: reproduced（macOS 26.5.1 / Google Chrome 150.0.7871.102）
- raw:
  - [[raw/chrome-devtools-browser-window-20260714]]
  - [[raw/chrome-devtools-target-window-20260714]]

## 結論

`--window-position=-32000,-32000` の存在は画面外配置の証拠にならない。2 display
構成では Chrome/macOS が窓を実画面内へ clamp し、CDP と Accessibility の遠方座標指定も
同様に画面内へ戻された。Apple の公開文書も Window Server 座標を ±16,000 に制限すると
しており、固定 `-32000` は公開契約の範囲外である。Apple 文書は MarkItDown だと
JavaScript 要求文だけになったため、Web取得結果を参照した。

文字どおりの offscreen 移動ではなく、次の CDP lifecycle が現行環境で要求を満たした。

1. Chrome を `--no-startup-window`、専用 profile、loopback CDP で URL なし起動する。
2. Window Server の画面上窓が 0 のまま browser websocket を取得する。
3. Chromeがhiddenなcold準備中に`Target.createTarget`を`newWindow=true`、
   `background=true`、`windowState=minimized`、ChatGPT URLで呼ぶ。
4. page target の `Browser.getWindowForTarget` と
   `Browser.getWindowBounds` で `minimized` を確認する。
5. 最小化確認後に正規PIDだけをunhideし、アプリをhiddenのまま運用しない。
6. modelsと実Chatを通した後も、同じPIDのWindow Server layer 0画面内windowが0件であることを確認する。

## 実測

- 従来 flag 付き PID 97895 は実際には `x=-2211, y=-1410, w=1200, h=1276` として
  Window Server の画面上一覧に残った。
- CDP `Browser.setWindowBounds(windowState=minimized)` 後は画面上 ChatGPT 窓が 0 になり、
  実 Chat が `MINIMIZED_OK` を返した。
- PID 17518 を `--no-startup-window` で cold start した時点は target 0、画面上窓 0。
- cold同時startでは新規Chrome PIDを実捕捉し、約10ms間隔・15秒の監視中もlayer 0画面内windowは最大0。2 processは`started` 1件と`already_ready` 1件へ収束した。
- listenerは`hidden=false`、CDPは`minimized`だった。その状態でmodels取得と実Chatが成功し、`ACCEPTED_NO_FLASH_OK`を返した後も画面内windowは0だった。
- Chromeは表示復帰後もCDPへ古い`minimized`を返す場合がある。`Browser.setWindowBounds(normal)`だけでは復帰しなかったが、一意page targetへの`Page.bringToFront`で画面内windowが0→1になり、再startで1→0へ戻った。

## 契約上の注意

- 「固定座標で画面外」は削除し、「窓なしcold startから最初からbackground最小化targetを作り、CDPとWindow Serverの両方で確認する」を正とする。表示・非表示の最終真実はtitleではなく正規PID＋layer 0の画面内window数とする。
- `Browser` / `Target` の当該 method は CDP 上 experimental なので、
  Chrome 更新後の cold smoke を互換ゲートに残す。
- app hide / `Cmd-H`、透明化、private SkyLight、別 Space へ fallback しない。
- 初回 login で人間が窓を必要とする導線は、通常の運用時最小化とは別に扱う。
