(() => {
  const form = document.querySelector('form[action="/authorize"]');
  const tokenInput = document.getElementById("device_token");
  if (!(form instanceof HTMLFormElement) || !(tokenInput instanceof HTMLInputElement)) return;

  const helper = tokenInput.previousElementSibling;
  const label = document.querySelector('label[for="device_token"]');
  let credential = "";

  chrome.runtime.sendMessage({ type: "getOAuthCredential" }, (result) => {
    if (chrome.runtime.lastError || !result?.ok || !result.mcpToken) return;
    credential = result.mcpToken;
    tokenInput.required = false;
    tokenInput.hidden = true;
    if (label instanceof HTMLElement) label.hidden = true;
    if (helper instanceof HTMLElement) {
      helper.textContent = "browserControl is connected. Click Authorize to grant this MCP client access to your Chrome session.";
    }
  });

  form.addEventListener("submit", (event) => {
    const submitter = event.submitter;
    if (!(submitter instanceof HTMLButtonElement) || submitter.value !== "approve" || !credential) return;
    tokenInput.value = credential;
  }, true);
})();
