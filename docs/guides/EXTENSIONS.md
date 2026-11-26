# Built-in extensions

An extension is a feature that plugs into the places HEISS UI already has (the
composer, gallery tiles, the viewer, the phone's Create sheet, Settings ›
Features, dialogs and sheets) without editing those files. It is one object on
the client and, when it needs the server, one object on the server, under the
same id. Every part is optional.

HEISS UI ships with one, `prompt-from-image` (server/prompt-from-image.js),
which only acts on workflows that configure it. With no extension configured
nothing renders, no request carries an `extensions` field, and workflows and
gallery settings look exactly as before.

## One name everywhere

The id (lowercase letters, digits and dashes) is the key in every place a value
travels:

| Where | What |
| --- | --- |
| `heissUi.extensions.<id>` | The workflow's config, normalized by the server's `workflow()` hook. Reaches the client as `profile.extensions.<id>`. |
| `body.extensions.<id>` | The value for one run, checked by the server's `body()` hook. |
| `settings.extensions.<id>` | What the gallery keeps, from the server's `settings()` hook. Try again and "Use these settings" bring it back. |
| `prefs.extensions.<id>` | `false` once someone switches it off in Settings › Features. On otherwise. |

## Client: `src/app/extensions.ts`

Add the object to `extensions`. Slots render with the studio's own controls, so
an extension looks like the rest of the app:

| Slot | Shows as |
| --- | --- |
| `composer` | An icon button beside Recent prompts, label in the tooltip. `active` lights it. |
| `createRows` | A row in the phone's Create sheet, after the model and size. |
| `tile` | A tile hover icon on a computer, a row in the phone's long-press sheet. |
| `viewer` | A dock button on a computer, a labelled button in the phone's viewer bar. Both sit before Delete. |
| `panels` | A dialog on a computer, a full sheet on a phone. Open one with `context.openPanel(id)`. |
| `settings` | A drawer in Settings › Features with the on/off switch, a description, a summary and anything under it. |
| `restore` | Turns a kept `settings.extensions.<id>` back into a value for the next run. |
| `available` | Hides every slot when it returns false, e.g. for a model whose workflow has no config for it. |

Each slot gets a context: the view, the current profile, this extension's
`config` from the workflow, `phone`, its `value` for the next run with
`setValue`, `openPanel` and `showToast`. A value that is set goes with the next
Generate; clear it with `setValue(undefined)`.

The hosts that draw the slots are in `src/app/ExtensionSlots.tsx`.

## Server: `server/extensions.js`

Add the object to `serverExtensions`:

| Hook | Does |
| --- | --- |
| `routes(app, helpers)` | Registers routes after sign-in. Guard them with `helpers.requireLocal` or `helpers.requireAdmin`. |
| `workflow(config, { graph, controls })` | Normalizes `heissUi.extensions.<id>`. Return null, or throw, to ignore it. |
| `requiredNodes(config)` | Node classes the config needs beyond the workflow's own graph. |
| `body(value, { workflow, profile, info })` | Checks a run's value. Return undefined to drop it; throw to refuse the run with that message. |
| `settings(value, { privateVault })` | What the gallery keeps. A Hidden run keeps only what this returns for `privateVault: true`. |
| `graph(graph, { workflow, body, value })` | The last change to the graph before it is queued. Runs when the workflow configures the extension or the run sends a value. |
| `profile(profile, { config, workflow })` | Changes the model profile of a workflow that configures it: a control's limits or choices, sizes, defaults. Generate checks runs against the same profile. |

`server/extensions.test.js` has a small extension that uses every hook; copy it
as a starting point and add tests beside it.

## Keep it like the rest

- Copy is sentence case and says what happens, as in the other Features drawers.
- Use tokens from `src/styles/00-tokens.css` and existing classes before adding
  CSS. If it needs its own, add a numbered file in `src/styles/`.
- A feature that changes a graph should still run when the workflow has no
  config for it: leave the graph alone.
