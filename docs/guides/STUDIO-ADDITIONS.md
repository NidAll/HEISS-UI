# Studio additions

This fork adds a set of features to HEISS UI v0.18.2. Each one sits on its own branch with its own
CHANGELOG line, so it can be offered upstream on its own; `port` holds them all together.

Most additions are **built-in extensions**. A workflow switches one on with a key under
`heissUi.extensions` ([workflow guide](../../workflows/README.md#extensions)), and anyone can switch
it off again in **Settings › Features**. Without its key, or without the node pack it needs, an
extension draws nothing and sends nothing. How the slots and hooks work: [EXTENSIONS.md](./EXTENSIONS.md).

## Framework

| Addition | What it does | Code | Branch |
| --- | --- | --- | --- |
| Extension registry | One list of extensions on the server (workflow config, run values, graph changes, results, profile fields, routes) and one in the browser (composer buttons, prompt tools, Create-sheet rows, tile and viewer actions, dialogs/sheets, Settings › Features drawers). | `server/extensions.js`, `src/app/extensions.ts`, `src/app/ExtensionSlots.tsx` | `registry` |
| Parts of the studio | Settings › Features switches for video, the negative prompt, images per run, the steps number, finding models, community links, the Hugging Face token, Civitai-ready images and earlier images. Off hides the part and sends nothing for it. | `src/app/featureSwitches.ts` | `feature-switches` |
| Live previews switch | Settings › Generation › Previews. Off leaves ComfyUI's own preview policy alone. | `server/prompt-extra.js` | `feature-switches` |
| Your own catalog | `catalog.json` in the data folder retires workflows, keeps others from deletion, hides automatic entries and names the first model ([CONFIGURATION.md](./CONFIGURATION.md#your-own-catalog)). | `server/catalog-rules.js` | `template-admin` |

## Composer and prompt

| Addition | Where you see it | Switched on by | Branch |
| --- | --- | --- | --- |
| **Enhance** | A button beside the prompt (under it on a phone). The prompt box glows while it rewrites, Stop cancels, Undo/Redo and Ctrl+Z step through rewrites. Settings › Features › Enhance picks the mode per model and can enhance short prompts before Generate. JSON prompts are left alone. | `prompt-enhance`: the workflow's own text-only graph | `prompt-tools` |
| **Styles** | A Styles button that opens PromptStyler Next's picker. The chosen looks go with every run, Use these settings brings them back, and Enhance aims at them. | `prompt-styler`, plus the [PromptStyler Next](https://github.com/NidAll/ComfyUI-PromptStyler-Next) pack | `styles` |
| **Character** | A Character dialog (a sheet on a phone) that builds a Danbooru tag prompt field by field: completion, suggestions, dice and lock per field, Randomize, Usual look, General/Sensitive, Undo, and unknown tags marked. | `character`, plus the [Character Helper](https://github.com/Adamovix/ComfyUI-Character-Helper) pack | `character` |
| **Layout** | A Layout dialog for MOSS layout prompts: boxes for objects, characters and text on a board the shape of the picture, summary, meta, canvas, palette, snapping, thirds, starters, a reference to trace over, import from JSON or a studio PNG, Undo/Redo. Its AI tab reads a reference into boxes, plans or changes a layout from words, writes captions, fits a box to its object and finds lettering. | `layout`, plus the [MOSS Image Prompt Builder](https://github.com/NidAll/comfyui-ming-image-prompt-builder) pack; `assist` for the AI tab | `layout` |
| **Workflow options** | A button named for the options (a Create row on a phone) that offers chosen node inputs as settings rows, with Reset. The viewer shows the prompt a node wrote, with Copy and Use as prompt. | `workflow-options` | `director` |
| **Prompt from image** | The prompt box reads "Optional direction…" and Generate runs with it empty when the workflow writes its own prompt from the start image. | `prompt-from-image` | `prompt-from-image` |
| **Sampling modes** | The steps control offers only the step counts a workflow is tuned for. | `sampling-modes` | `step-choices` |
| **2K sizes** | The size menu's 2K tab draws the sizes a workflow was trained for. | `size-tiers` | `twok-sizes` |
| Phone prompt label | The phone's prompt pill shows a layout as "Layout · 4 boxes · caption" instead of its JSON. | `promptLabel` slot | `layout` |

## Gallery and viewer

| Addition | Where you see it | Switched on by | Branch |
| --- | --- | --- | --- |
| **Again, Clone this, Final 2K** | Tile hover row, viewer dock, phone viewer bar and long-press sheet. Again reruns with a new seed; Clone this sends the picture to a model that writes its prompt from an image; Final 2K reruns the seed at the workflow's 2K size. | on; Settings › Features switches it off. Clone and Final 2K show where a model can do them | `quick-actions` |
| **Compare** | A viewer action: pick a picture as A, then compare another with it, split or side by side. | on; Settings › Features switches it off | `compare` |
| **Clipboard** | Paste a picture anywhere into the reference slot. On plain HTTP, Copy image opens the picture for the system's copy menu. | always on | `clipboard` |
| **Workflow groups** | The model picker lists a workflow under its group; the gallery search has a chip per group and per workflow. | `workflow-group` | `gallery-filters` |
| Use these settings | Brings back the run's own workflow (by profile id), its seed and every reference slot. | always on | `restore` |

## Fixes

Each is one commit with a test that fails without it (`core-fixes` and the branches named).

- Seed 0 is used as seed 0, not as "random".
- The progress-socket wait ends at once for a closed socket and lets go of its listeners and timer.
- ComfyUI's node list is fetched once for callers that arrive together and reused for up to 15
  minutes while jobs run.
- A template card shows a picture that is still in the gallery, never a Hidden one.
- With ComfyUI offline, workflows read "Not checked" instead of "Needs setup".
- LoRAs loaded by `LoraLoader` / `LoraLoaderModelOnly` count in a workflow's missing-file check.
- Tile hover actions wrap instead of running under the upscale button (`quick-actions`).
- Generation details name the workflow instead of its id (`director`).

## Left out or simplified

The old studio had more on screen. These were dropped or folded into something smaller:

- **Prompt tools:** the Ideas menu and its chips, the Anima entity chips, Convert to MOSS for
  Ideogram prompts, the Clear button and the fallback writer models are gone. Enhance is one
  button; its modes live in Settings › Features › Enhance.
- **Director:** became the general Workflow options dialog and the viewer's written-prompt panel.
- **Styles:** the composer row shows only the Styles button; the chips and the pause switch live
  in the pack's own dialog.
- **Character:** the per-field picture counts are gone; counts come from the pack.
- **Layout:** zoom and pan, align and split tools, golden-ratio guides, Ideogram 4 import and
  export, `.bbox` import, the paste pad, Stretch and 1:1 reference fits, Shift aspect lock, the
  right-click menu and Save .json (Copy covers it) are gone.
- **Gallery:** the queue and ETA strip and the anime/photoreal chips became workflow-group chips;
  creative recipes are gone (pinned Recent prompts cover them); the composer's destination chip
  is gone (the Hidden chip and dock lock show it).
- **Sizes:** the per-template 1K / 2 MP tabs and the Flux resolution calculator became the
  upstream size menu plus the 2K tab.
- **Workflow format:** optional media branches were dropped (no workflow used them).
