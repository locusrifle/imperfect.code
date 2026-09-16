# Image Lab

Pictures made on the machine owner's own ChatGPT subscription, filed in their
workspace, with the references they were made from kept beside them.

## What it is made of

| piece | file | what it owns |
|---|---|---|
| the engine | `native/codex-images.mjs` | the token, the request, the streamed frames |
| the library | `native/image-lab.mjs` | pictures, pins, folders, boards on disk |
| the boards | `native/pinterest.mjs` | the Pinterest app, its token, fetching pins |
| the routes | `native/lab-routes.mjs` | `/lab/*` |
| the page | `native/public/image-lab.html`, `css/image-lab.css`, `js/image-lab.js` | the wall and the prompt |
| the tool | `extensions/image-lab/` | `generate_image`, so the harness can draw too |

The engine has two callers and one implementation: the lab's own prompt box,
and the agent's `generate_image` tool. A picture made either way lands in the
same library. That is deliberate — two doors onto one collection, not two
collections.

## The credential

**There is no API key.** Pi already ships *ChatGPT Plus/Pro (Codex)* as a login
provider and OpenAI endorses third-party harnesses using it, so the lab borrows
the sign-in the machine already has:

```sh
pi   # then /login, choose ChatGPT Plus/Pro
```

The token is fetched with `pi auth print-bearer-token --provider openai-codex`,
which refreshes it under Pi's own file lock. **Nothing in the lab writes to
`auth.json`.** A refresh token is single-use, and a second writer racing Pi
would eventually spend one twice and sign the person out of their own machine.

A machine with no ChatGPT sign-in is not broken: `/lab/state` reports
`codex.signedIn: false`, the prompt box explains itself, and boards, filing and
importing all still work.

Anthropic subscriptions are deliberately *not* an option here, for the same
reason they are absent from the sign-in dialog: their terms do not allow a
Claude subscription to drive another harness. OpenAI's position is the
opposite, which is the only reason this ships.

## Where the pictures live

Under the workspace, so the person can find them with the files app, a shell,
or a backup:

```
<workspace>/images/
  library.json              the index: prompts, references, folders
  pictures/<id>.png         what was made
  pins/<id>.<ext>           inspiration, cached on this machine
  pinterest.json            the Pinterest app and token, mode 600
```

**The directory is the truth.** Every read reconciles against it: a picture on
disk with no index entry is adopted, an entry with no file is dropped. Losing
`library.json` loses the prompts, never the pictures.

`pinterest.json` holds credentials and must never be packed into a release —
it lives under `data/`, which `install/imperfect.mjs pack` already refuses.

## Inspiration

Every reference image is copied onto the machine. This is forced — the product
serves `default-src 'self'`, so a remote image URL cannot be drawn in the page
at all — and it is right anyway: a board of other people's URLs stops being a
board the day those URLs rot.

Two ways in:

- **Drop, paste, or pick a file.** Works today, needs nothing.
- **Pinterest.** Needs a Pinterest developer app, which needs their approval.
  Scopes are `boards:read,pins:read` — the lab never writes to an account.
  The redirect URI is `<origin>/lab/pinterest/callback` and must match the one
  registered on the app exactly; `/lab/state` reports the value in use so a
  mismatch can be compared rather than guessed.

## Streaming

Generation and board import both answer as server-sent events rather than one
reply at the end. A picture takes the better part of a minute, and this product
has already learned once — in the app drawer — that a surface which shows
nothing while it waits is indistinguishable from a broken one. The endpoint
sends partial frames as the picture resolves; the lab fades each one in.

Because the headers leave when the stream opens, a failure **cannot** come back
as a status code. It arrives as an `{"type":"error"}` frame, and the page reads
it from there.

## Proving it

```sh
node --test native/test/image-lab.test.mjs
```

Eleven cases, none of which spend the subscription: the engine is injected.
What they cover that is worth knowing — the directory reconciling against a
lost index, an id that is a path being refused rather than sanitised, the same
pin not becoming two pins, a failure arriving in the stream instead of the
status, lab POSTs requiring an origin, the lab being absent from a stock
machine, and an unsolicited Pinterest callback being refused.

The end-to-end path is not in the suite because it costs a real picture. To
walk it by hand:

```sh
cd /tmp/scratch
pi --print --extension <repo>/extensions/image-lab --tools generate_image \
   "Use generate_image once to draw a plain red circle on white."
ls images/pictures
```
