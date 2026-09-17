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
// alt+Enter opens a line. Nothing else is claimed.
const CLAUDE_COMPACT = [
	['escape', 'interrupt'],
	['/', 'commands'],
	['ctrl+o', 'more'],
];

const CLAUDE_EXPANDED = [
	['escape', 'to interrupt'],
	['ctrl+c', 'to interrupt a running turn'],
	['/', 'for commands'],
	['ctrl+o', 'to expand tools'],
	['enter', 'to send'],
	['alt+enter', 'for a new line'],
];

// A runtime may hand over a version that already carries its own name
// ("claude 2.1.273"). Printing that after the name gives the doubled line this
// file exists to remove, so a face says how its own version reads.
const FACES = {
	pi: {
		name: 'pi',
		versionLabel: version => `v${version}`,
		note: 'Pi can explain its own features and look up its docs. Ask it how to use or extend Pi.',
		compactHints: PI_COMPACT,
		expandedHints: PI_EXPANDED,
	},
	claude: {
		name: 'claude',
		// "claude 2.1.273" from the runtime becomes "2.1.273" beside the name.
		versionLabel: version => String(version).replace(/^claude\s+/i, ''),
		note: 'Claude reads CLAUDE.md, which points at AGENTS.md so both harnesses share one set of instructions.',
		compactHints: CLAUDE_COMPACT,
		expandedHints: CLAUDE_EXPANDED,
	},
};

export const faceFor = agent => FACES[agent] ?? FACES.pi;
