document.documentElement.classList.add("ready");

const controls = document.querySelector("#auth-controls");

function signedOutControls() {
  controls.innerHTML = `
    <button class="auth-link" type="button" data-auth="sign-in">Sign in</button>
    <button class="button auth-button" type="button" data-auth="sign-up">Get started</button>`;
  controls.querySelector('[data-auth="sign-in"]').addEventListener("click", () => window.Clerk.openSignIn({ forceRedirectUrl: window.location.href }));
  controls.querySelector('[data-auth="sign-up"]').addEventListener("click", () => window.Clerk.openSignUp({ forceRedirectUrl: window.location.href }));
}

function signedInControls() {
  controls.innerHTML = '<span class="signed-in-label">Signed in</span><div id="user-button"></div>';
  window.Clerk.mountUserButton(controls.querySelector("#user-button"));
}

async function initializeClerk() {
  if (!window.Clerk) {
    controls.textContent = "Account controls are unavailable.";
    return;
  }
  await window.Clerk.load({ ui: { ClerkUI: window.__internal_ClerkUICtor } });
  if (window.Clerk.user) signedInControls();
  else signedOutControls();
  window.Clerk.addListener(({ user }) => {
    if (user) signedInControls();
    else signedOutControls();
  });
}

window.addEventListener("load", () => {
  initializeClerk().catch(() => {
    controls.textContent = "Account controls are unavailable.";
  });
});
