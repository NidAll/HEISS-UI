# Custom Workflows

HEISS UI can load ComfyUI API workflow templates from this folder or from the app data workflow folder shown in Settings.

Use ComfyUI's API workflow JSON format, then add a `heissUi` block that tells the simple UI which node inputs map to common controls.

```json
{
  "heissUi": {
    "id": "my-workflow",
    "name": "My Workflow",
    "kind": "image",
    "controls": {
      "prompt": { "node": "4", "input": "text" },
      "negative": { "node": "5", "input": "text" },
      "width": { "node": "6", "input": "width" },
      "height": { "node": "6", "input": "height" },
      "steps": { "node": "7", "input": "steps" },
      "cfg": { "node": "7", "input": "cfg" },
      "sampler": { "node": "7", "input": "sampler_name" },
      "scheduler": { "node": "7", "input": "scheduler" },
      "seed": { "node": "7", "input": "seed" }
    }
  },
  "4": {
    "class_type": "CLIPTextEncode",
    "inputs": {}
  }
}
```

Only mapped controls are changed by HEISS UI. Everything else stays exactly as it was in the exported ComfyUI API workflow.

The controls it can map are `prompt`, `negative`, `seed`, `steps`, `cfg`, `sampler`, `scheduler`, `denoise`, `width`, `height`, `count` (batch size), `frames`, `fps` and `startImage`, plus the loader choices `model`, `textEncoder`, `vae`, `clipType` and `weightDtype`. Each points at one input on one node. A second sampler or prompt encoder keeps its saved values unless you feed both from one node (a core `PrimitiveInt` or `PrimitiveString`) and map that.

Importing without a `heissUi` block works too: HEISS UI guesses the mapping from node types and order (the first text encoder is the prompt, the second the negative, the first sampler gets seed and steps). The import review marks those guesses and lists what follows the studio and what stays as saved. Its **Copy for an agent** button copies a prompt, with the workflow, that asks an AI agent to write the `heissUi` block for you; the prompt lives in `src/app/workflowAgentGuide.ts`.

Smart upscale's 2K and 4K picks work with imported workflows too: the upscale runs in the same ComfyUI job, after the workflow's own output. Inpainting doesn't: an imported workflow gets reference and start images, not the brush.

## Image-to-image inputs

Declare image editing explicitly rather than relying only on a `LoadImage`
node:

```json
{
  "heissUi": {
    "capabilities": { "imageToImage": true },
    "mediaInputs": [{
      "id": "reference",
      "kind": "image",
      "label": "Reference image",
      "required": true,
      "min": 1,
      "max": 1,
      "control": { "node": "369", "input": "image" }
    }],
    "promptComposition": {
      "prefix": "Edit: ",
      "suffix": "Keep everything else the same.",
      "policy": "preserve-source-v1",
      "version": 1
    }
  }
}
```

The user prompt stays unchanged in gallery history. Prefix and suffix text are
applied only to the graph input. Existing workflows with `controls.startImage`
are automatically exposed as an optional single-image media input.

Visual workflow imports prefer ComfyUI's `widgets_values_named` map when it is
available. This avoids positional drift from UI-only widget values such as
`control_after_generate` and upload controls.

## Power LoRA Loader

An API workflow can opt in to HEISS UI's LoRA picker with an existing rgthree Power LoRA Loader:

```json
{
  "heissUi": {
    "capabilities": { "lora": true },
    "loraStack": {
      "adapter": "rgthree-power-v1",
      "node": "4",
      "max": 8
    }
  }
}
```

The referenced node must be `Power Lora Loader (rgthree)` and already have its model and CLIP wiring connected. HEISS UI replaces only its `lora_` inputs using the selected LoRAs, in sidebar order.

The simpler rgthree stack used by the bundled Flux 2 edit workflow is also
supported:

```json
{
  "heissUi": {
    "capabilities": { "lora": true },
    "loraStack": {
      "adapter": "rgthree-stack-v1",
      "node": "374",
      "max": 4
    }
  }
}
```

## Extensions

A built-in extension can read its own settings from the workflow, under
`heissUi.extensions` and keyed by its id:

```json
{
  "heissUi": {
    "extensions": {
      "my-extension": { "node": "12", "input": "text" }
    }
  }
}
```

Keys for extensions this copy of HEISS UI doesn't have are ignored, so the
workflow still loads everywhere. See
[docs/guides/EXTENSIONS.md](../docs/guides/EXTENSIONS.md).

### Sampling modes

For a model tuned for a few step counts, name them; the steps control then
offers only those, by name, and Generate turns other counts down. It needs a
mapped `steps` control and at least two modes. The first mode is the default
when `defaults.steps` isn't one of them.

```json
"extensions": {
  "sampling-modes": {
    "modes": [
      { "steps": 8, "label": "Quality (8-step)" },
      { "steps": 4, "label": "Flash (4-step)" }
    ]
  }
}
```

### Size tiers

For a model trained for a second, larger size, say what the size menu's 2K tab
draws: each shape in `aspectRatios` at `megapixels` million pixels, both sides
on a `divisibleBy` grid (default 64), rounded as ComfyUI's Flux resolution
calculator does. Without it, 2K draws each shape with its long side at 2048.

```json
"extensions": {
  "size-tiers": { "tiers": [{ "label": "2K", "megapixels": 2.36, "divisibleBy": 64 }] }
}
```

### Prompt from image

For a workflow that writes its own prompt from its start image (an
image-to-prompt node feeding the text encoder), say so; the prompt box then
becomes an optional direction and Generate runs with it empty once the image is
in. It needs a mapped `startImage` control or a media input.

```json
"extensions": {
  "prompt-from-image": {}
}
```

### Workflow group

Give a workflow a group name to list it under that name in the model picker,
in place of "Your workflows". The gallery search then shows a chip for the
group and one for each workflow in it; a chip keeps only the pictures made
with them.

```json
"extensions": {
  "workflow-group": { "name": "Anime" }
}
```
