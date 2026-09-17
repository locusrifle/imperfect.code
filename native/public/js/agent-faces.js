// What each harness looks like when it introduces itself.
//
// One machine runs two harnesses behind the same four members, and everything
// below this file is genuinely shared: the transport, the tab host, the dialog
// channel, sessions, the desk. What is *not* shared is how a harness announces
// itself, and pretending otherwise is how a Claude session came to open under
// the line `pi vclaude 2.1.273` — Pi's name, with Claude's version worn as a
// version number.
//
// So this is a slot, not a theme. An agent supplies a whole face; it does not
// fill in a colour on somebody else's. The startup header is the first one,
// because it was the loudest thing saying the wrong name.
//
// The hints are the part that has to stay honest. Pi's rows below are the Pi
// TUI's own bindings, kept exactly as they were so that nothing about Pi's
// appearance changes here — but note that `!`, `!!` and `ctrl+d` are not
// implemented anywhere in this GUI. They are true of the terminal Pi and false
// of this window. A face should only advertise a key its own surface answers,
// which is why Claude's rows are shorter than they could be: every one of them
// was checked against a handler in harness.js.

const PI_COMPACT = [
	['escape', 'interrupt'],
	['ctrl+c/ctrl+d', 'clear/exit'],
	['/', 'commands'],
	['!', 'bash'],
	['ctrl+o', 'more'],
];

const PI_EXPANDED = [
	['escape', 'to interrupt'],
	['ctrl+c', 'to clear'],
	['ctrl+c twice', 'to exit'],
	['ctrl+d', 'to exit (empty)'],
	['ctrl+z', 'to suspend'],
	['ctrl+k', 'to delete to end'],
	['shift+tab', 'to cycle thinking level'],
	['ctrl+p/shift+ctrl+p', 'to cycle models'],
	['ctrl+l', 'to select model'],
	['ctrl+o', 'to expand tools'],
	['ctrl+t', 'to expand thinking'],
	['ctrl+g', 'for external editor'],
	['!', 'to run bash'],
	['!!', 'to run bash (no context)'],
];

// Verified against harness.js: Escape interrupts, ctrl+c aborts a running
// turn, `/` opens the slash menu, ctrl+o expands, Enter sends and
// shift+Enter opens a line. Nothing else is claimed.
const CLAUDE_COMPACT = [
	['escape', 'interrupt'],
	['/', 'commands'],
	['shift+tab', 'cycle permission mode'],
	['ctrl+o', 'more'],
];

const CLAUDE_EXPANDED = [
	['escape', 'to interrupt'],
	['ctrl+c', 'to interrupt a running turn'],
	['/', 'for commands'],
	['shift+tab', 'to cycle permission mode'],
	['ctrl+o', 'to expand tools'],
	['enter', 'to send'],
	['shift+enter', 'for a new line'],
];

// A runtime may hand over a version that already carries its own name
// ("claude 2.1.273"). Printing that after the name gives the doubled line this
// file exists to remove, so a face says how its own version reads.

// The slash catalogue is the second slot, and it was the same mistake as the
// header wearing a different hat: a Claude tab listed Pi's twenty-three stock
// commands — /scoped-models, /export, /share, /changelog, /hotkeys, /fork,
// /clone, /trust, /thinking, /tree, /compact, /reload — most of which have no
// implementation for Claude at all and were rendered only to throw "not
// available in Guey yet" when pressed. The SDK's init names are considered
// only after a matching Claude runtime case exists.
//
// So a face names the commands it actually answers, in the order it wants
// them. A runtime-reported name is admitted only when its own switch has a
// matching case; an init frame is not permission to advertise a dead command.

const PI_SLASH_VIEW = {
	'/settings': ['settings', 'Open settings menu'],
	'/model': ['model', '<provider/model> – Select model (opens selector UI)'],
	'/tree': ['tree', 'Navigate session tree (switch branches)'],
	'/thinking': ['thinking', '<level> – Set thinking level'],
	'/scoped-models': ['scoped-models', 'Enable/disable models for Ctrl+P cycling'],
	'/export': ['export', 'Export session (HTML default, or specify path: .html/.jsonl)'],
	'/import': ['import', 'Import and resume a session from a JSONL file'],
	'/share': ['share', 'Share session as a secret GitHub gist'],
	'/copy': ['copy', 'Copy last agent message to clipboard'],
	'/name': ['name', 'Set session display name'],
	'/session': ['session', 'Show session info and stats'],
	'/changelog': ['changelog', 'Show changelog entries'],
	'/hotkeys': ['hotkeys', 'Show all keyboard shortcuts'],
	'/fork': ['fork', 'Create a new fork from a previous user message'],
	'/clone': ['clone', 'Duplicate the current session at the current position'],
	'/trust': ['trust', 'Save project trust decision for future sessions'],
	'/login': ['login', '<provider> – Configure provider authentication'],
	'/logout': ['logout', 'Remove provider authentication'],
	'/new': ['new', 'Start a new session'],
	'/compact': ['compact', 'Manually compact the session context'],
	'/resume': ['resume', 'Resume a different session'],
	'/reload': ['reload', 'Reload keybindings, extensions, skills, prompts, themes, and context files'],
	'/quit': ['quit', 'Quit Guey'],
};

// Every row below was checked against claude-runtime.mjs's own command switch,
// whose default case throws. Deliberately absent, because they are Pi verbs
// that a Claude tab cannot run: /tree, /fork, /clone, /compact, /thinking,
// /reload, /scoped-models, /export, /import, /share, /changelog, /hotkeys,
// /trust — and also /new and /resume, which the switch does not implement
// either, so offering them would be offering a thrown error. The native TUI's
// /effort is different: the SDK exposes it for models that advertise effort,
// so the harness keeps the row but filters it until such a model is selected.
const CLAUDE_SLASH_VIEW = {
	'/model': ['model', 'Select the model this session runs on'],
	'/effort': ['effort', 'Set effort for the current Claude model'],
	'/name': ['name', 'Set session display name'],
	'/copy': ['copy', 'Copy last agent message to clipboard'],
	'/session': ['session', 'Show session info and stats'],
	'/settings': ['settings', 'Claude reads its settings from .claude/, not from this panel'],
	'/quit': ['quit', 'Quit Guey'],
};

const FACES = {
	pi: {
		name: 'pi',
		versionLabel: version => `v${version}`,
		note: 'Pi can explain its own features and look up its docs. Ask it how to use or extend Pi.',
		compactHints: PI_COMPACT,
		expandedHints: PI_EXPANDED,
		slashView: PI_SLASH_VIEW,
	},
	claude: {
		name: 'claude',
		// The runtime sends "claude 2.1.273" once a session has started, and the
		// bare word "claude" before one has — there is no version to report until
		// the SDK's init frame arrives. Stripping the name off the first gives
		// "2.1.273"; the second must come back empty, or the header reads
		// "claude claude" while a person waits for their first prompt.
		versionLabel: version => String(version).replace(/^claude\s*/i, ''),
		// The native Claude TUI has no explanatory line under its hints, so this
		// face has none either. A sentence about CLAUDE.md is a thing this GUI
		// wanted to say, not a thing Claude says.
		note: null,
		compactHints: CLAUDE_COMPACT,
		expandedHints: CLAUDE_EXPANDED,
		slashView: CLAUDE_SLASH_VIEW,
	},
};

export const faceFor = agent => FACES[agent] ?? FACES.pi;
