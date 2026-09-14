// Pi's opening sentence. We replace this one line so the model is not only a
// coding assistant. Tools, guidelines, and Pi docs stay.
export const PI_OPENING = 'You are an expert coding assistant operating inside pi, a coding agent harness. You help users by reading files, executing commands, editing code, and writing new files.';

export function displayPerson(person) {
  const name = String(person || '').trim();
  if (!name) return 'this person';
  return name.charAt(0).toUpperCase() + name.slice(1);
}

export function fillEnvironment(template, person) {
  return String(template || '').replaceAll('{{NAME}}', displayPerson(person));
}

export function applyEnvironment(systemPrompt, environment) {
  const ours = String(environment || '').trim();
  const current = String(systemPrompt || '');
  if (!ours) return current;
  if (current.includes(PI_OPENING)) return current.replace(PI_OPENING, ours);
  if (!current.includes("personal computing assistant")) return `${ours}\n\n${current}`;
  return current;
}
