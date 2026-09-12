# Workflow Canvas User Guide

This guide explains how to use the Workflow Canvas in the app.

Feature path:
- `/create-workflow`

Use this document when onboarding teammates, testing the feature, or continuing implementation work.

## What the Workflow Canvas is

The Workflow Canvas is a visual editor for building generation flows with connected nodes.

Instead of filling one form at a time, you can:
- add prompt and media input nodes
- connect them to generation nodes
- save the canvas as a reusable workflow
- run one node or run a downstream branch

It is best understood as a visual orchestration layer on top of the existing image, video, motion, and audio generation tools.

## Main areas of the screen

### Left rail
- `Node palette`: add new nodes to the canvas
- `Saved canvases`: switch between saved workflow canvases
- `New`: create a new workflow canvas

### Top bar
- canvas title
- save button
- `Run node`
- `Run from here`
- `Delete node` when a node is selected

### Center canvas
- infinite canvas for arranging nodes
- drag nodes to reposition them
- connect node handles by dragging from one handle to another
- pan and zoom to move around large workflows

### Right inspector
- edit the currently selected node
- upload input media
- change prompts
- change model settings
- review node run state and output preview

## Node types

### Prompt
- stores plain text
- outputs `text`
- use it to feed prompts into generation nodes

### Image input
- upload an image
- outputs `image`
- use it as a reference for image, video, or motion workflows

### Video input
- upload a video
- outputs `video`
- use it as a reference for motion workflows

### Audio input
- upload an audio file
- outputs `audio`
- useful today as a standalone audio asset node
- it is not yet used as a downstream dependency for video generation

### Image generator
- consumes `prompt`
- can also take an optional image reference
- outputs a generated `image`

### Video generator
- consumes `prompt`
- can also take an optional image reference
- outputs a generated `video`

### Motion control
- consumes one `image` and one `video`
- can also take an optional prompt
- outputs a generated `video`

### Voiceover
- consumes `prompt`
- outputs generated `audio`
- supports ElevenLabs text-to-speech and dialogue models

### Sound effects
- consumes `prompt`
- outputs generated `audio`
- supports ElevenLabs sound-effect generation

### Note
- annotation only
- does not run
- does not feed other nodes

### Group
- visual grouping only
- use it to organize a section of the canvas

## Supported connections

Only these connections are valid right now:

| From | To |
| --- | --- |
| `text` | `prompt` |
| `image` | `reference-image` |
| `video` | `reference-video` |

Important:
- audio-to-video wiring is not enabled yet
- invalid connections are blocked in the UI

## Recommended first workflow

If you are new to the feature, start with one of these simple flows.

### Flow 1: Prompt to image
1. Add a `Prompt` node
2. Add an `Image generator` node
3. Connect `Prompt -> Image generator`
4. Select the prompt node and write your prompt in the inspector
5. Select the image generator and choose the model and output settings
6. Click the image generator
7. Click `Run node`

### Flow 2: Prompt to video
1. Add a `Prompt` node
2. Add a `Video generator` node
3. Connect `Prompt -> Video generator`
4. Configure duration, model, and native audio settings
5. Run the video node

### Flow 3: Image + video into motion
1. Add an `Image input` node
2. Add a `Video input` node
3. Add a `Motion control` node
4. Upload an image to the image input
5. Upload a video to the video input
6. Connect `Image input -> Motion control`
7. Connect `Video input -> Motion control`
8. Optionally connect a `Prompt` node into motion
9. Run the motion node

### Flow 4: Prompt to voiceover
1. Add a `Prompt` node
2. Add a `Voiceover` node
3. Connect `Prompt -> Voiceover`
4. Select the voiceover node
5. Choose the voice model and tune the settings
6. Run the voiceover node

### Flow 5: Prompt to sound effect
1. Add a `Prompt` node
2. Add a `Sound effects` node
3. Connect `Prompt -> Sound effects`
4. Set duration and output format
5. Run the node

## How to edit a node

1. Click a node on the canvas
2. Use the right inspector to edit its fields
3. Changes autosave after a short delay
4. You can also click `Save` manually from the top bar

Examples:
- prompt text is edited from the inspector
- image, video, and audio uploads are done from the inspector
- generator model settings are changed from the inspector

## How execution works

### Run node
- runs only the selected node
- uses whatever upstream inputs are already connected and available

### Run from here
- starts from the selected node
- continues through downstream nodes in topological order
- if an upstream generation is still processing, dependent nodes are queued and resumed during polling

### Node statuses
- `idle`: not run yet
- `queued`: waiting for an upstream dependency
- `processing`: generation has started
- `succeeded`: generation finished successfully
- `failed`: generation failed
- `blocked`: the node cannot run because a required dependency or input is missing

## Saving behavior

- canvases autosave while you work
- clicking `Save` forces an immediate save
- viewport position is also saved, so reopening a canvas should return you to the same area

## Output behavior

- generated outputs appear inside the node card when available
- image outputs show an inline image preview
- video outputs show an inline video preview
- audio outputs show an inline audio player
- audio generations also appear on the `Creations` page

## Deleting nodes

You can delete a selected node in three ways:
- click `Delete node` in the top bar
- click `Delete selected node` in the inspector
- press `Delete` or `Backspace` when a node is selected and focus is not inside a form field

Deleting a node also removes its connected edges.

## Current limitations

These are important so expectations stay clear:

- there is no node duplication yet
- right-click creation is not implemented yet
- connector deletion UX is still basic
- `music-generate` exists in the schema but is intentionally hidden until a real backend is added
- external audio cannot yet be connected into video generation
- audio compositing and final export assembly are not implemented yet
- note and group nodes are organizational only

## Troubleshooting

### A node says `blocked`
Usually one of these is true:
- a required prompt was not connected
- a required image or video input is missing
- an upstream node failed
- a connected upstream output does not exist yet

### A node stays `queued`
It is waiting for an upstream node to finish successfully.

### My output is not visible
- wait for polling to refresh the run state
- click another canvas and return if needed
- confirm the generation also appears on the `Creations` page

### Audio is generated but does not feed video
That is expected for now. Audio generation works as a standalone output, but video compositing is not implemented yet.

## Best practices

- start simple with one prompt and one generator
- branch only after the first path works
- use `Note` nodes for instructions and testing context
- use clear titles for nodes so queued and failed states are easier to understand
- save separate canvases for different ad concepts instead of overloading one giant canvas

## Suggested follow-up docs later

If the feature grows, it would be useful to split this into:
- beginner quick-start
- node reference
- troubleshooting guide
- advanced workflow examples
