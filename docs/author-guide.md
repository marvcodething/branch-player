# Making an interactive story

This guide shows you how to build a story where viewers pick what happens next. You don't need any technical knowledge. If you can drag things around and upload a video, you can do this.

**You'll need:** a few video clips and Branch Player open on the **Stories** page.

---

## The big idea

A story is a set of **nodes** joined by **links**.

- A **node** is one video clip.
- A **link** is a choice the viewer can make at the end of that clip. It leads to the next node.

Near the end of a clip, the viewer sees the choices. Whichever one they pick, the next clip starts right away with no gap, so it feels like one continuous film.

Here is a tiny story:

```
                 ┌──► [ You go left ]  (End)
[ The Fork ] ────┤
                 └──► [ You go right ] (End)
```

"The Fork" is the opening clip. At its end the viewer chooses *Go left* or *Go right*, and each choice plays its own ending.

**What a node does depends on how many links leave it:**

| Links out of a node | What the viewer sees |
|---|---|
| **None** | It's an **ending**. The story finishes after this clip. The card is tagged **End**. |
| **One** | The story **continues on its own** to the next clip. No choice is shown. |
| **Two to four** | The viewer gets a **choice menu**. |

---

## Part 1: Make your first story

### 1. Create a story

On the **Stories** page, click **+ New story**, give it a name, and open it with **Edit**. You can rename it any time by clicking its name on the Stories page.

You'll land in the editor, which is a big blank map. Your story already has one node on it, tagged **Start**. That's where every viewer begins.

### 2. Add your opening clip

1. Click the node to select it. A panel opens on the right.
2. Under **Name**, type something short, like `The Fork`.
3. Under **Video**, click **Upload clip…** and choose your video. You can also drag a video file straight onto the Video box.

Most common video types work (MP4, MOV, MKV, WebM, M4V). The clip is stored with this story only.

> Uploads can take a moment for large files. Wait for the progress bar to finish before moving on.

### 3. Add the next clips

Hover over the **right edge** of your node. You'll see a small yellow dot. Drag from it:

- **onto empty space** to create a brand-new node and a link to it in one move, or
- **onto another node** to link to a node you already have.

Do it twice from the opening node to make two choices. Then click each new node, give it a name, and upload its clip.

You can also add a loose node with the **+ Node** button at the bottom, or by double-clicking an empty spot on the map.

### 4. Word the choices

Click the opening node. In the panel, under **Choices**, each link has a label. Change them to what the viewer should read, like `Go left` and `Go right`.

Use the **Prompt** box for a question that appears above the choices, like `Which way?`.

### 5. Try it

Click **Draft play** at the bottom. The editor saves your work, prepares a quick preview and shows a link: **Open player**. Click it, press **Start** and watch.

When the opening clip nears its end, the choices appear. Click one (or press the number key 1, 2, 3 or 4), and the story carries on.

That's a complete story.

---

## Part 2: Shaping the story

### Choices and defaults

- Choices are shown in order. **The first choice is the default.** If the viewer doesn't pick anything in time, that's the one that plays. To change the default, reorder the choices in the panel.
- Each node can use a different rule. Open **Overrides** in the panel to choose **Take a random choice** instead, or to change how early the choices show up.
- Choices lock in just under a second before the clip ends, so the next clip can start with no gap. After that, the pick can't be changed.

### How long viewers have to choose

By default, choices appear **5 seconds** before the clip ends. Open **Overrides** and set **Choice window** to change it for one node. Use a longer window for big decisions and a shorter one for quick beats.

> Tip: if a clip is shorter than its choice window, the choices simply appear from the start of the clip. Very short branching clips leave the viewer little time, so give them a longer clip or a quicker default.

### Joining branches back together

Links can lead to a node that other links also lead to. Two different paths can end up in the same scene. That's a good way to give viewers a sense of choice without filming twice as much.

### Changing and removing things

| To… | Do this |
|---|---|
| Move a node | Drag its title bar. |
| Rename a node | Select it and edit **Name**. |
| Change where a link goes | Click the link, then drag one of the round grips at its ends onto another node. |
| Delete a link | Click it and press **Delete**, or use the **Delete** button beside it in the panel. |
| Delete a node | Select it and press **Delete**, or use **Delete node** in the panel. This also removes every link leading to it, and you'll be asked to confirm. |
| Change the opening clip | Select a node and click **Set as start**. |
| Replace a node's video | Pick or upload another clip under **Video**. |
| Remove an unused clip | Click **Clips** at the bottom. Clips still used by a node can't be deleted. |

The start node can't be deleted. Make another node the start first.

### Getting around the map

- **Drag** empty space to move around.
- **Scroll** to move, or **pinch** (or hold Ctrl or Cmd while scrolling) to zoom.
- Keys: `+` and `-` zoom, `1` resets to 100%, and `0` fits the whole story on screen.
- **Esc** deselects.

Your work **saves automatically** a moment after each change. The **Save** button forces a save right away.

---

## Part 3: Previewing

There are two preview buttons at the bottom:

| Button | Use it when… |
|---|---|
| **Draft play** | You're still working. It prepares a smaller, lower-quality version that is **much faster**. Use it as often as you like. |
| **Play** | You want to see the real quality. It takes longer, especially the first time. |

Things worth knowing:

- **The first preparation is the slowest.** After that, only clips you've changed are redone, so later previews are quicker.
- Draft and full-quality previews are kept separately, so one doesn't undo the other.
- The preview waits for you to press **Start**. Browsers need a click before they will play sound.

---

## Checking your story

The bar at the bottom of the editor tells you if something needs fixing, and a **problems** list appears in the panel for the selected node.

**Errors** stop you from previewing:

| Message | What to do |
|---|---|
| **No video** | A node has no clip. Upload one or choose one under **Video**. |
| **Video not found** | The clip was removed. Upload it again or pick another. |

**Warnings** don't stop you, but they usually mean a mistake:

| Message | What it means |
|---|---|
| **Unreachable from start** | No path leads to this node, so no viewer will ever see it. Add a link to it, or delete it. |
| **More than 4 choices** | Only the keys 1 to 4 pick a choice, so keep it to four. |
| **Choice without a label** | A choice on a menu has no text. Give it a name. |

---

## Tips for good results

- **Keep clips close in look.** Every clip is converted to the same size and frame rate, so a very different clip may be shown with black bars rather than stretched.
- **Cut clips so the end flows into every possible next clip.** The next scene starts on the very next frame.
- **Give viewers time.** Choices appear before the end of a clip, so keep the last few seconds of a branching clip calm enough to read the options.
- **Silent clips are fine.** They play with silence, and the story keeps going.
- **Plan on paper first.** Sketch the nodes and links, then build the map. It's much easier than reworking it.

---

## When something goes wrong

**The Draft play or Play button is greyed out.** There's an error to fix. Read the message in the bar at the bottom.

**The preview says it couldn't be built.** Read the text in the window that appears. Most often a clip is damaged or is not really a video. Try re-uploading it.

**Nothing happens when the story should start.** Press **Start** in the player. Browsers don't play video until you click.

**The wrong clip played after a choice.** If the viewer doesn't choose in time, the default (first) choice plays. Check the order of your choices.

**I can't delete a clip.** It's still used by a node. Change that node's video first.

**My changes aren't showing in the preview.** Make sure you started a new preview after editing. The player shows the last version that was prepared.

**It's taking a long time.** Use **Draft play** while editing. Large, high-resolution clips take longest on the first preparation.

---

## Quick reference

| Do this | To… |
|---|---|
| Double-click empty map | Add a node there |
| Drag from a node's yellow dot | Add a link or create a new node |
| Click a link | Select it (then drag its grips to change where it goes) |
| Delete key | Remove the selected node or link |
| `+` / `-` / `0` / `1` | Zoom in / zoom out / fit all / 100% |
| Keys `1`–`4` in the player | Pick a choice |
