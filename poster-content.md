# Branch Player: Making Interactive Video Cut Seamlessly

*A video player where the story branches and the viewer never sees the seam*

[Your name] · [Advisor] · Occidental College, Computer Science Comprehensive Project, Fall 2026

## Main takeaway
**Interactive stories need video that switches between clips on the exact next frame. Branch Player does this in a web browser, where the usual approach drops about 3 frames at every cut.**

## One-sentence pitch
"I built the video engine for choose-your-own-adventure films, so when you pick a path, the next scene starts instantly with no flicker, freeze or audio pop."

## Elevator pitch (30 seconds)
Shows like Netflix's *Bandersnatch* let you choose what happens next. Under the hood, the player has to jump from one video clip to another without you noticing. Most web players pause for a moment when they switch, and my first prototype did too: about a tenth of a second, which is 3 frames, at every cut. I rebuilt the player so all the clips feed into one continuous stream, and I measured whether each cut lands on exactly the next frame. I also built a visual editor where someone can draw a story as a graph of clips and play it.

---

## Introduction and Problem
- Interactive films let viewers pick what happens next, and the story branches.
- The experience only works if the next clip starts on the very next frame. Any freeze, flicker or audio gap breaks the illusion.
- Web browsers aren't built for this. Each time a standard player starts a new clip, it has to restart its internal pipeline.

*Visual idea:* a small story-graph picture (one clip splitting into two choices, then rejoining). Label one cut "the seam".

## Background
- **A "seam"** is the moment one clip ends and the next begins. The goal is a seam that lasts exactly one frame, which is the normal gap between frames.
- **Two-player approach (what I tried first):** stack two video players and swap them. Each swap restarts the pipeline, which cost about 100 ms (3 frames) at every cut.
- **Stream approach (what I settled on):** the browser lets a program feed video pieces into a single player, so the viewer sees one continuous video. The viewer never sees where pieces join, so there's nothing to restart.
- **Audio is the hard part.** Even a few thousandths of a second of silence can make a browser's player stall.

*Visual idea:* two side-by-side timelines. Top: "Two players", with a gap at the cut. Bottom: "One stream", with clips butted together.

## Prior Work
- Interactive film: Netflix's *Bandersnatch* showed the format is popular.
- Story tools: Twine is the well-known tool for branching text stories, and it inspired my editor's look.
- Standard streaming (adaptive-bitrate players) is built for one long video, not for hopping between many short clips.
- [Add 2-4 real citations with years. Verify them; none are invented here. Examples to look up: the W3C Media Source Extensions spec, Netflix's technical write-up on *Bandersnatch*, HLS or DASH documentation.]

## Methods

### A. Preparing the videos
- Every clip is converted to the same format, because the browser can't join clips that are encoded differently. Authors can upload any format, and the conversion happens ahead of time.
- Each clip is chopped into short pieces that always begin at a "full" frame the player can start from, which makes clean cuts possible.
- Clips with no sound get silent audio added, since a missing audio stretch freezes the whole player.
- Audio runs slightly past the end of each clip, and the next clip's audio overlaps it, so the sound never has a hole.

### B. Playing the story
- The player feeds pieces into one video stream, so the browser sees a single continuous video.
- It downloads the starting pieces of every possible next clip ahead of time, so whatever the viewer picks is already there.
- Each choice follows a four-step lifecycle: *scheduled* (start downloading candidates), *choice window* (viewer can pick), *locked* (next clip gets queued exactly at the end), *handoff* (the player measures the cut on the first frame it shows).
- If the viewer doesn't choose in time, or playback stalls, it picks the default path rather than waiting forever.
- Old video is cleared from memory as the viewer progresses, but never too close to the current frame.

### C. Making stories
- A visual editor shows the story as boxes and arrows. You drag clips around, draw choices between them, and press Play.
- Each story lives in its own project folder, and the editor saves it as a plain text file.
- Stories can be exported as a self-contained website that anyone can host.

### D. Keeping it testable
- An automated test plays through the story in a headless browser and records the length of every seam.
- Playtesters and story authors are interviewed to cover what the numbers can't (see Evaluation).

*Visual idea (big center diagram):* box-and-arrow architecture: Story file → Converter (prepares clips) → Engine (one continuous stream) → Video on screen, with the editor feeding the story file. Add a small timeline strip of one choice showing the four lifecycle steps.

## Evaluation
The project is judged three ways: how fast the cut is (latency), what viewers experience (playtester interviews), and whether the tool works for the people who make stories (user interviews).

### 1. Latency (the numbers)
- **Metric:** the time between the last frame of one clip and the first frame of the next. A perfect seam is one frame, which is 33.3 ms at 30 frames per second.
- **Also measured:** playback stalls, which should be zero.
- **Comparison:** the first two-player prototype, which measured about 100 ms.
- **Method:** an automated headless-browser test plays the demo story for a set time and logs every seam. It runs once with no choices made (defaults only) and once with choices made.
- **Why:** the viewer perceives a cut as smooth when it takes exactly one frame, so measuring in frames is the honest test.

### 2. Playtester interviews (the viewer's experience)
- **Who:** [N] people who watch a branching story made with the player. [Say how you recruit them, e.g. classmates, non-CS students.]
- **What they do:** watch and make choices, then answer a short set of questions.
- **What we ask about:** Did you notice any cut, freeze, flicker or sound glitch? Did the choices feel natural, and was there enough time to decide? Did the story feel like one continuous film?
- **Why:** latency numbers say the cut is fast, but only a viewer can say whether it feels seamless.

### 3. User interviews (the author's experience)
- **Who:** [N] people who build a small story in the editor. [Say who: classmates, film or writing students, etc.]
- **What they do:** make a short branching story in the node-and-edge editor, then play it back.
- **What we ask about:** Was the graph easy to understand? Was adding clips and drawing choices clear? What was confusing, missing or frustrating? Would you use it again?
- **Why:** the player only matters if people can actually make stories for it.

### Ethics of the interviews
- [State consent, anonymity and how responses are stored. Check whether your school requires approval for interviews.]

## Results  *(fill in; do not present targets as measured)*

### Latency
- Seams measured: [N]
- Average seam length: [__ ms] ([__] frames; target about 33.3 ms, 1.00 frames)
- Longest seam: [__ ms]
- Stalls: [__] (target 0)
- Prototype for comparison: about 100 ms (3 frames)
- Browser and machine tested on: [__]

### Playtester interviews
- Participants: [N]
- Noticed a glitch at a cut: [__ of N]
- Main themes: [__]
- Representative quote: "[__]"

### User interviews
- Participants: [N]
- Main themes (what worked, what was confusing): [__]
- Changes made because of the feedback: [__]
- Representative quote: "[__]"

*Visual idea:* bar chart (prototype about 100 ms next to Branch Player [__ ms]), a small chart or checklist of interview themes, and a screenshot of the editor's graph. Prepare a backup chart or handout in case the final data isn't ready. Interviews may not be finished by 11/22, so a "what we learned so far" box is acceptable.

## Ethical Considerations
- **Accessibility:** interactive video needs captions and keyboard-only choices, and a timed choice can exclude some viewers. [State what you did or plan.]
- **Persuasion by design:** the author controls which options exist and how long the viewer has to decide. That can be used to steer viewers.
- **Copyright and consent:** the editor lets people upload their own clips, and the tool can't tell whether they have the right to use them.
- **Privacy:** everything runs on the user's own machine, with no accounts and no cloud storage. [Say whether that holds for viewers of exported stories.]

## Limitations and Future Work
- Works best on desktop browsers. Mobile is next, especially iPhones, which handle this technology differently.
- Quality is fixed. A future version could switch quality up and down with the viewer's internet speed.
- A choice can't be changed after it is locked in.
- Stories can't remember earlier choices yet. Future versions could track variables, like "you took the key".
- A full authoring app with editing and previews is the long-term goal.

## Takeaways
- Seamless branching is a timing problem, and it works best when the player never restarts.
- Preparing the clips carefully ahead of time (same format, clean start points, safe audio) matters as much as the player code.
- Measuring every seam automatically makes the claim checkable, and interviews with viewers and authors show whether it feels seamless and is usable.

## Footer
- QR code to the GitHub repo [add URL]. It covers the replication instructions and code overview, which the rubric treats as appendices.
- [Optional] QR code to a live demo.
- Acknowledgements: [advisor, department].

---

## Design concept: the poster IS a story graph
The poster should look like the project's own editor: a canvas of **nodes (cards)** joined by **edges (arrows)**, the same way a story is drawn in the software. The reader follows the arrows like a viewer following choices through a branching film.

- **Each section is a node (a card).** Give each card a short title bar and a few bullets, like a clip card in the editor.
- **Arrows are the reading order.** Draw curved or straight arrows from card to card. Where the story branches, the arrows split, and where it rejoins they merge.
- **Start node:** the title and main takeaway, like the first clip of a story.
- **Ending nodes:** Takeaways and the QR code, like story endings.
- **Choice points:** the places where the reader can go two ways (for example, Evaluation splitting into Latency, Playtester interviews and User interviews) should show as one node with several outgoing edges, labelled with the choice text.
- **Style:** match the editor's look: rounded cards on a calm canvas, thin arrows with arrowheads, small labels on edges. Use the editor's colour tokens from `public/editor.css` (light and dark) so the poster matches the software. Take a screenshot of the editor as the reference.
- **A real screenshot:** include the actual editor graph as one of the cards, so the poster's design and the product look the same.

### Suggested graph (48"x36" landscape, flows left to right)
```
[Title + Takeaway] --> [Problem] --> [Background: two players vs one stream]
                                          |
                                          v
                                  [Prior Work] --> [Methods: the big architecture node]
                                                        |
                              +-------------------------+-------------------------+
                              v                         v                         v
                  [Eval 1: Latency]      [Eval 2: Playtester interviews]  [Eval 3: User interviews]
                              \                         |                         /
                               +------------------------+------------------------+
                                                        v
                                                  [Results]
                                                        |
                                    +-------------------+-------------------+
                                    v                   v                   v
                                [Ethics]         [Future work]         [Takeaways + QR code]
```
- The three Evaluation nodes branch out from Methods and merge back into Results, which shows off the graph idea.
- Use arrow labels like "how it works", "how we tested it" and "what we found" so the flow is readable.
- A small legend ("card = section, arrow = reading order") helps non-CS visitors.

Keep text short with no paragraphs. The title should read from several feet away. Arrows must be easy to follow, so avoid crossing them.

## Logistics
- Posters due **11/22** for printing; printed copies back 11/30 for practice.
- Presentations **Tuesday 12/1, 5-7pm**, Library LA Reading Room. Two groups, about an hour each.
- Maximum size 48"x36"; submit a high-resolution PDF.
- Graded by completion, plus a short reflection.

---

# Conversation prep (not on the poster)

## Likely questions and short answers
- *Why not just use two video players?* I tried that, and it cost about 3 frames per cut because each swap restarts the pipeline.
- *Why do audio gaps matter so much?* A gap of even a few thousandths of a second can make the browser's player stall.
- *What if the viewer picks late or never picks?* The engine locks the default path, so playback never waits.
- *Why interviews and not just the latency numbers?* The numbers say the cut is fast, but only viewers can say whether it feels seamless, and only authors can say whether the editor is usable.
- *Why does the poster look like a graph?* It copies the node-and-edge editor the software uses, so the poster's design is the product's design.
- *What would you do with more time?* Quality that adapts to internet speed, mobile support, and stories that remember choices.
- *What was the hardest bug?* [Your honest story here. Seam timing and audio overlap are good candidates.]

## Details to memorize (keep off the poster)
- All clips share one encoding format.
- Each piece starts on a full frame (a "keyframe").
- Audio runs slightly past the video end.
- The engine touches the video buffer only through a single queue, so two operations never collide.

## Live demo option
Run the demo on a laptop at the poster with a story that has two obvious branches.
