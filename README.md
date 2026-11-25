# Sides

A self-tape teleprompter for actors. It scrolls your sides and speaks the other
characters' lines aloud, so you can rehearse and record an audition without a
live reader.

**Live at [michaelkai88.github.io/sides](https://michaelkai88.github.io/sides/)**

## What it does

- **Reads the script.** Import sides as a PDF, `.txt`, `.fountain`, `.fdx` or
  `.md`, or paste the text straight in. It works out who says what, and you fix
  anything it got wrong before you start.
- **Plays the other parts.** Each character gets its own voice — your device's
  built-in speech (free), ElevenLabs, or OpenAI. Lines are generated once,
  before the take, and cached, so a rerun costs nothing.
- **Waits for you.** Hands-free mode listens and moves on when you stop talking.
  There is also tap-to-advance and continuous scroll.
- **Starts anywhere.** Resume where you left off, or jump to any line.
- **Optional cross-device sync.** A sync code can carry scripts, settings and
  generated audio between, say, a laptop and an iPad. It talks to a Supabase
  project configured at the top of `index.html`; point it at your own to use
  it. Everything else works with no account and no network.

## Running it

The whole app is a single `index.html` — no build step and no dependencies.
Open the file, or serve the folder over http. PDF.js is fetched from a CDN only
when you import a PDF; nothing else touches the network during a take.

```
node harness.js     # the test suite
```

API keys are entered in the app and stored on your own device. None are in this
repository.
