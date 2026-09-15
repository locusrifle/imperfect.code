// Browser teardown helpers. Linux Doom's I_Quit calls each subsystem in a
// fixed order and then exits the process. In the browser the individual
// shutdown calls may return promises, so invoke every stage synchronously in
// source order, then wait for all of them without letting one failure suppress
// the remaining stages.

export function I_RunQuitSequence({
  D_QuitNetGame,
  I_ShutdownSound,
  I_ShutdownMusic,
  M_SaveDefaults,
  I_ShutdownGraphics,
}) {
  const steps = [
    D_QuitNetGame,
    I_ShutdownSound,
    I_ShutdownMusic,
    M_SaveDefaults,
    I_ShutdownGraphics,
  ];
  const errors = new Array(steps.length);
  const failed = new Array(steps.length).fill(false);
  const values = new Array(steps.length);
  const pending = new Array(steps.length);

  // Do not await between calls. The C functions are synchronous, and the
  // browser equivalents claim their resources synchronously before returning
  // any close/disposal promise. This preserves both I_Quit's call order and
  // the immediate RAF-stop guarantee when quit is requested from a ticker.
  for (let i = 0; i < steps.length; i++) {
    try {
      pending[i] = Promise.resolve(steps[i]()).then(
        (value) => { values[i] = value; },
        (error) => { failed[i] = true; errors[i] = error; },
      );
    } catch (error) {
      failed[i] = true;
      errors[i] = error;
      pending[i] = Promise.resolve();
    }
  }

  return Promise.all(pending).then(() => {
    const failures = errors.filter((_error, i) => failed[i] === true);
    if (failures.length !== 0) {
      throw new AggregateError(failures, 'I_Quit cleanup failed');
    }
    // The graphics report is the only shutdown result with useful diagnostics.
    return values[4];
  });
}

// Run dynamically imported graphics cleanup steps independently. A failed
// import is just another failed step: later modules must still unload and the
// renderer/context finalizer must still run.
export async function I_RunCleanupSteps(steps, errors = []) {
  for (const step of steps) {
    try {
      await step();
    } catch (error) {
      errors.push(error);
    }
  }
  return errors;
}
