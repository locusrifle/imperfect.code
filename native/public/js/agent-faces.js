// One face. The engines underneath are not costumes.
//
// An earlier pass treated "feel like the native Claude TUI" as a second product
// chrome: Claude's name, Claude's hints, Claude's slash wall. Noah looking at
// that split: this GUI is a meta wrapper. Pi and Claude Code are backends.
// The native TUI to imitate is this window's composer, which is Pi's.
//
// So presentation is one object. A backend still names the commands it actually
// answers — advertising a verb the engine cannot run is how a Claude tab listed
// twenty-three Pi commands that only threw. That table is plumbing, not a face.

const COMPACT = [
	['escape', 'interrupt'],
	['ctrl+c/ctrl+d', 'clear/exit'],
	['/', 'commands'],
	['!', 'bash'],
	['ctrl+o', 'more'],
];

const EXPANDED = [
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

const FACE = {
	name: 'pi',
	versionLabel: version => {
		const text = String(version ?? '').trim();
		if (!text) return '';
		const stripped = text.replace(/^claude\s*/i, '').replace(/^pi\s*/i, '').replace(/^v/i, '');
		return stripped ? `v${stripped}` : '';
	},
	note: 'Pi can explain its own features and look up its docs. Ask it how to use or extend Pi.',
	compactHints: COMPACT,
	expandedHints: EXPANDED,
};

const PI_COMMANDS = {
	'/settings': ['settings', 'Open settings menu'],
	'/model': ['model', '<provider/model> – Select model (opens selector UI)'],
	'/harness': ['harness', 'auto, or pin an engine this tab is allowed to use'],
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

// Every row below was checked against claude-runtime.mjs's command switch,
// whose default case throws. /harness is answered by the tab host, not Claude.
const CLAUDE_COMMANDS = {
	'/model': ['model', 'Select the model this session runs on'],
	'/harness': ['harness', 'auto, or pin an engine this tab is allowed to use'],
	'/effort': ['effort', 'Set effort for the current Claude model'],
	'/name': ['name', 'Set session display name'],
	'/copy': ['copy', 'Copy last agent message to clipboard'],
	'/session': ['session', 'Show session info and stats'],
	'/settings': ['settings', 'Claude reads its settings from .claude/, not from this panel'],
	'/quit': ['quit', 'Quit Guey'],
};

export const faceFor = () => FACE;
export const commandsFor = agent => agent === 'claude' ? CLAUDE_COMMANDS : PI_COMMANDS;
export const permissionFor = agent => agent === 'claude'
	? { className: 'claude-permission', hint: 'enter chooses · esc cancels' }
	: null;
