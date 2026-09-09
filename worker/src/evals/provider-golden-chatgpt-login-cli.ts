#!/usr/bin/env node
import { goldenChatGptLoginFailureMessage, runGoldenChatGptLogin } from "./provider-golden-chatgpt-login.js";

runGoldenChatGptLogin(process.argv.slice(2)).then((code) => { process.exitCode = code; }).catch((error) => {
  process.stderr.write(goldenChatGptLoginFailureMessage(error));
  process.exitCode = 2;
});
