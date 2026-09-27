const { run } = require('./bot');

run().catch((error) => {
  // run() already reports through core.setFailed, but a rejection that escapes
  // an unexpected path would otherwise vanish and leave only a bare exit code.
  if (error instanceof Error) {
    console.error(error.stack || error.message);
  } else {
    console.error(error);
  }
  process.exitCode = 1;
});
