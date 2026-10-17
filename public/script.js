"use strict";

const $ = (id) => document.getElementById(id);
let config;
let currentUser = null;
let pendingOtp = null;
let resendTimer = null;
let resendUntil = 0;
let conversations = [];
let selectedChat = null;
let turns = [];
let sending = false;
let historyRequest = 0;
let accountGeneration = 0;
let pendingAttempt = null;
let dialogAction = "";
let imageMode = false;
let imageWorking = false;
let imageItems = [];
let imageAttempt = null;
let imageListRequest = 0;
let otpStartUntil = 0;
let otpStartTimer = null;
let otpExpiryTimer = null;

function notice(id, message = "", kind = "") {
    const element = $(id);
    element.textContent = message;
    element.className = `notice ${id === "chatNotice" ? "chat-notice" : ""} ${kind} ${message ? "" : "hidden"}`;
}

function showScreen(id, clearNotice = true) {
    $("bootScreen").classList.add("hidden");
    $("chatShell").classList.add("hidden");
    $("authShell").classList.remove("hidden");
    document.querySelectorAll(".auth-screen").forEach((screen) => screen.classList.toggle("hidden", screen.id !== id));
    if (clearNotice) notice("authNotice");
}

function friendlyError(error) {
    if (["TypeError", "TimeoutError", "AbortError"].includes(error?.name)) return "Could not connect. Check your internet connection and that the server is running, then try again.";
    return error?.message || "Something went wrong. Please try again.";
}

function mobileValue(id) { return $(id).value.trim(); }

async function withForm(form, label, action) {
    if (form.dataset.busy === "true") return;
    form.dataset.busy = "true";
    const button = form.querySelector("button[type=submit]");
    const oldLabel = button.textContent;
    button.disabled = true;
    button.textContent = label;
    notice("authNotice");
    try { await action(); }
    catch (error) {
        notice("authNotice", friendlyError(error), "error");
        if (error.retryAfter && ["signupForm", "forgotForm"].includes(form.id)) lockOtpStarts(error.retryAfter);
    }
    finally {
        delete form.dataset.busy;
        button.disabled = false; button.textContent = oldLabel;
        if (["signupForm", "forgotForm"].includes(form.id)) updateOtpStarts();
        if (form.id === "verifyForm" && pendingOtp && Date.parse(pendingOtp.expiresAt) <= Date.now()) button.disabled = true;
    }
}

async function api(route, options = {}) {
    const { timeoutMs = 70000, ...fetchOptions } = options;
    const response = await fetch(route, {
        ...fetchOptions,
        credentials: "same-origin",
        headers: { "Content-Type": "application/json" },
        signal: AbortSignal.timeout(timeoutMs)
    });
    let result;
    try { result = await response.json(); } catch { throw new Error("The server returned an unexpected response. Please try again."); }
    if (!response.ok) {
        const failure = new Error(result.message || "Request failed.");
        failure.status = response.status;
        failure.retryAfter = Number(response.headers.get("Retry-After")) || Number(result.retryAfter) || 0;
        failure.code = result.code;
        if (result.supportReference) failure.message += ` Reference: ${result.supportReference}.`;
        if (response.status === 401 && currentUser && !route.startsWith("/api/auth/")) {
            clearAccount();
            showScreen("loginScreen");
            notice("authNotice", failure.message, "error");
        }
        throw failure;
    }
    return result;
}

function setSidebar(open) {
    $("sidebar").classList.toggle("open", open);
    $("sidebarBackdrop").classList.toggle("hidden", !open);
    $("openSidebar").setAttribute("aria-expanded", String(open));
}

function clearAccount() {
    if ($("actionDialog").open) $("actionDialog").close();
    accountGeneration++;
    imageMode = false;
    imageWorking = false;
    imageItems = [];
    imageAttempt = null;
    imageListRequest++;
    $("imageGallery").replaceChildren();
    $("imagePrompt").value = "";
    $("imageLoading").classList.add("hidden");
    $("generateImageButton").disabled = false;
    historyRequest++;
    currentUser = null;
    conversations = [];
    selectedChat = null;
    turns = [];
    pendingAttempt = null;
    sending = false;
    $("messages").replaceChildren();
    $("conversationList").replaceChildren();
    $("messageInput").value = "";
    $("userName").textContent = "Your account";
    $("userMobile").textContent = "";
    $("thinking").classList.add("hidden");
    setSidebar(false);
}

function setUserLabel(name, mobile) {
    $("userName").textContent = name || "Your account";
    $("userMobile").textContent = mobile || "";
    $("userInitial").textContent = (name || "U").slice(0, 1).toUpperCase();
}

async function enterAccount(user) {
    clearAccount();
    clearOtp();
    currentUser = user;
    const generation = accountGeneration;
    setUserLabel(user.name, user.mobile);
    $("bootScreen").classList.add("hidden");
    $("authShell").classList.add("hidden");
    $("chatShell").classList.remove("hidden");
    notice("chatNotice");
    newChat();
    try { await refreshConversations(false, generation); }
    catch (error) { if (generation === accountGeneration) notice("chatNotice", friendlyError(error), "error"); }
    if (generation === accountGeneration && !config.chatConfigured) notice("chatNotice", "Chat needs a Gemini API key. Add GEMINI_API_KEY to the server’s .env file and restart it.", "error");
}

function renderConversations() {
    $("conversationList").replaceChildren();
    if (!conversations.length) {
        const empty = document.createElement("p");
        empty.className = "empty-history";
        empty.textContent = "Your conversations will appear here. Start with something you’re curious about.";
        $("conversationList").append(empty);
    }
    for (const conversation of conversations) {
        const button = document.createElement("button");
        button.type = "button";
        button.className = `conversation-button ${conversation.id === selectedChat ? "active" : ""}`;
        button.title = conversation.title;
        button.disabled = sending;
        if (conversation.id === selectedChat) button.setAttribute("aria-current", "true");
        const symbol = document.createElement("span");
        symbol.textContent = "◌";
        symbol.setAttribute("aria-hidden", "true");
        const title = document.createElement("span");
        title.textContent = conversation.title;
        button.append(symbol, title);
        button.addEventListener("click", () => openConversation(conversation.id));
        $("conversationList").append(button);
    }
}

async function refreshConversations(append = false, generation = accountGeneration) {
    const result = await api(`/api/conversations?offset=${append ? conversations.length : 0}`);
    if (generation !== accountGeneration) return;
    conversations = append ? [...conversations, ...result.conversations.filter((item) => !conversations.some((old) => old.id === item.id))] : result.conversations;
    $("moreChatsButton").classList.toggle("hidden", !result.hasMore);
    renderConversations();
}

function setTitle(title) {
    if (!imageMode) $("chatTitle").textContent = title;
    $("renameButton").classList.toggle("hidden", !selectedChat || imageMode);
    $("deleteButton").classList.toggle("hidden", !selectedChat || imageMode);
}

function newChat() {
    if (sending) return;
    setImageMode(false);
    historyRequest++;
    selectedChat = null;
    pendingAttempt = null;
    turns = [];
    $("messageInput").value = "";
    $("messages").replaceChildren();
    $("welcome").classList.remove("hidden");
    $("olderButton").classList.add("hidden");
    setTitle("A new conversation");
    notice("chatNotice");
    renderConversations();
    updateComposer();
    setSidebar(false);
}

async function openConversation(id, older = false) {
    if (sending) return;
    setImageMode(false);
    const request = ++historyRequest;
    const generation = accountGeneration;
    notice("chatNotice");
    const oldest = older ? turns[0]?.turn_index : null;
    $("olderButton").disabled = true;
    try {
        const result = await api(`/api/conversations/${id}${oldest ? `?before=${oldest}` : ""}`);
        if (request !== historyRequest || generation !== accountGeneration || sending) return;
        selectedChat = id;
        pendingAttempt = null;
        turns = older ? [...result.turns, ...turns] : result.turns;
        if (!older) $("messageInput").value = "";
        setTitle(result.conversation.title);
        $("welcome").classList.toggle("hidden", turns.length > 0);
        $("olderButton").classList.toggle("hidden", !result.hasMore);
        renderMessages();
        renderConversations();
        updateComposer();
        setSidebar(false);
        if (!older) scrollToEnd();
    } catch (error) {
        if (request === historyRequest && generation === accountGeneration) notice("chatNotice", friendlyError(error), "error");
    } finally { $("olderButton").disabled = false; }
}

function messageElement(role, text) {
    const article = document.createElement("article");
    article.className = `message ${role}`;
    const label = document.createElement("div");
    label.className = "message-label";
    label.textContent = role === "user" ? "YOU" : "CHAT BOAT";
    const body = document.createElement("div");
    body.className = "message-body";
    // Use textContent throughout, including code blocks. Never render model HTML.
    if (role === "assistant") {
        const segments = text.split(/```(?:[^\n`]*\n)?/);
        segments.forEach((segment, index) => {
            if (!segment) return;
            if (index % 2) {
                const pre = document.createElement("pre");
                const code = document.createElement("code");
                code.textContent = segment.replace(/\n$/, "");
                pre.append(code);
                body.append(pre);
            } else {
                const paragraph = document.createElement("p");
                paragraph.textContent = segment;
                body.append(paragraph);
            }
        });
    } else {
        const paragraph = document.createElement("p");
        paragraph.textContent = text;
        body.append(paragraph);
    }
    article.append(label, body);
    if (role === "assistant") {
        const copy = document.createElement("button");
        copy.className = "copy-button";
        copy.type = "button";
        copy.textContent = "Copy answer";
        copy.addEventListener("click", async () => {
            try { await navigator.clipboard.writeText(text); copy.textContent = "Copied"; }
            catch { copy.textContent = "Select the text to copy"; }
            setTimeout(() => { copy.textContent = "Copy answer"; }, 2000);
        });
        article.append(copy);
    }
    return article;
}

function renderMessages() {
    $("messages").replaceChildren();
    for (const turn of turns) $("messages").append(messageElement("user", turn.user_message), messageElement("assistant", turn.assistant_message));
}

function scrollToEnd() { $("chatScroll").scrollTop = $("chatScroll").scrollHeight; }

function updateComposer() {
    $("characterCount").textContent = `${$("messageInput").value.length.toLocaleString()} / 4,000`;
    $("sendButton").disabled = sending || !$("messageInput").value.trim() || !config?.chatConfigured;
    $("messageInput").disabled = sending;
    for (const id of ["newChatButton", "renameButton", "deleteButton", "logoutButton", "moreChatsButton", "olderButton"]) $(id).disabled = sending;
    document.querySelectorAll("[data-prompt], .conversation-button").forEach((button) => { button.disabled = sending; });
}

async function sendMessage(event) {
    event.preventDefault();
    const message = $("messageInput").value.trim();
    if (sending || !message || message.length > 4000 || !config.chatConfigured) return;
    const generation = accountGeneration;
    historyRequest++;
    sending = true;
    updateComposer();
    notice("chatNotice");
    $("welcome").classList.add("hidden");
    const optimistic = messageElement("user", message);
    $("messages").append(optimistic);
    $("thinking").classList.remove("hidden");
    scrollToEnd();
    let sent = false;
    try {
        if (!selectedChat) {
            const created = await api("/api/conversations", { method: "POST", body: "{}" });
            if (generation !== accountGeneration) return;
            selectedChat = created.conversation.id;
            conversations.unshift(created.conversation);
            setTitle(created.conversation.title);
            renderConversations();
        }
        if (!pendingAttempt || pendingAttempt.conversationId !== selectedChat || pendingAttempt.message !== message) {
            pendingAttempt = { requestId: crypto.randomUUID(), conversationId: selectedChat, message };
        }
        const result = await api("/api/chat", { method: "POST", body: JSON.stringify(pendingAttempt) });
        if (generation !== accountGeneration) return;
        if (!turns.some((turn) => turn.id === result.turn.id)) turns.push(result.turn);
        pendingAttempt = null;
        sent = true;
        $("messageInput").value = "";
        renderMessages();
        try {
            await refreshConversations();
            if (generation === accountGeneration) setTitle(conversations.find((item) => item.id === selectedChat)?.title || "Conversation");
        } catch { notice("chatNotice", "Your answer was saved. The conversation list could not refresh; reload the page to update it."); }
    } catch (error) {
        if (generation !== accountGeneration) return;
        optimistic.remove();
        notice("chatNotice", `${friendlyError(error)} Your message is still below; you can send it again.`, "error");
    } finally {
        if (generation === accountGeneration) {
            sending = false;
            $("thinking").classList.add("hidden");
            updateComposer();
            if (sent) scrollToEnd();
            $("messageInput").focus();
        }
    }
}

async function signOut() {
    await api("/api/auth/logout", { method: "POST", body: "{}" });
    clearAccount();
    clearOtp();
    showScreen("loginScreen");
}

function openAction(action) {
    if (!selectedChat || sending) return;
    dialogAction = action;
    const rename = action === "rename";
    $("dialogTitle").textContent = rename ? "Rename conversation" : "Delete this conversation?";
    $("dialogDescription").textContent = rename ? "Give this conversation a name you’ll recognize." : "This removes the conversation and its saved messages. This cannot be undone.";
    $("renameInput").classList.toggle("hidden", !rename);
    $("renameLabel").classList.toggle("hidden", !rename);
    $("renameInput").required = rename;
    $("renameInput").value = $("chatTitle").textContent;
    $("dialogConfirm").textContent = rename ? "Save name" : "Delete conversation";
    $("dialogError").textContent = "";
    $("actionDialog").showModal();
    if (rename) $("renameInput").select();
}

function clearOtp() {
    pendingOtp = null;
    clearInterval(resendTimer);
    clearInterval(otpExpiryTimer);
    otpExpiryTimer = null;
    resendTimer = null;
    $("verificationCode").value = "";
    $("newPassword").value = "";
    $("confirmPassword").value = "";
}

function startResendCountdown(seconds) {
    clearInterval(resendTimer);
    resendUntil = Date.now() + seconds * 1000;
    const update = () => {
        const remaining = Math.max(0, Math.ceil((resendUntil - Date.now()) / 1000));
        $("resendButton").disabled = remaining > 0;
        $("resendButton").textContent = remaining ? `Resend in ${remaining}s` : "Resend OTP code";
        if (!remaining) clearInterval(resendTimer);
    };
    update();
    resendTimer = setInterval(update, 1000);
}

function showOtp(result, purpose) {
    pendingOtp = { ...result, purpose };
    const reset = purpose === "reset";
    $("verificationMobile").textContent = result.mobile;
    $("verifyHeading").textContent = reset ? "Reset your password." : "Verify your mobile.";
    $("verifySubmit").textContent = reset ? "Verify & save password" : "Verify & create account";
    $("resetFields").classList.toggle("hidden", !reset);
    for (const id of ["newPassword", "confirmPassword"]) {
        $(id).required = reset;
        $(id).disabled = !reset;
        $(id).value = "";
    }
    $("verificationCode").value = "";
    showScreen("verifyScreen");
    notice("authNotice", result.message, "success");
    startResendCountdown(result.retryAfter);
    $("verificationCode").focus();
    clearInterval(otpExpiryTimer);
    const progress = () => {
        if (!pendingOtp) return;
        const seconds = Math.max(0, Math.ceil((Date.parse(pendingOtp.expiresAt) - Date.now()) / 1000));
        $("otpProgress").textContent = seconds
            ? `Code expires in ${Math.floor(seconds / 60)}:${String(seconds % 60).padStart(2, "0")}. Reference: ${pendingOtp.supportReference || "—"}`
            : "This request expired. Go back and request a fresh code.";
        $("verifySubmit").disabled = seconds === 0 || $("verifyForm").dataset.busy === "true";
        if (!seconds) { clearInterval(otpExpiryTimer); clearInterval(resendTimer); $("resendButton").disabled = true; }
    };
    progress();
    otpExpiryTimer = setInterval(progress, 1000);
}

document.querySelectorAll("[data-screen]").forEach((button) => button.addEventListener("click", () => {
    clearOtp();
    showScreen(button.dataset.screen);
    if (button.dataset.screen === "forgotScreen") $("forgotMobile").value = mobileValue("loginMobile");
}));
document.querySelectorAll("[data-toggle]").forEach((button) => button.addEventListener("click", () => {
    const field = $(button.dataset.toggle);
    field.type = field.type === "password" ? "text" : "password";
    button.textContent = field.type === "password" ? "Show" : "Hide";
    button.setAttribute("aria-label", `${field.type === "password" ? "Show" : "Hide"} password`);
}));
$("changeMobileButton").addEventListener("click", () => {
    const screen = pendingOtp?.purpose === "reset" ? "forgotScreen" : "signupScreen";
    clearOtp();
    showScreen(screen);
});

$("signupForm").addEventListener("submit", (event) => {
    event.preventDefault();
    withForm(event.currentTarget, "Sending OTP…", async () => {
        const result = await api("/api/auth/signup/start", { method: "POST", body: JSON.stringify({
            name: $("signupName").value.trim(), mobile: mobileValue("signupMobile"), password: $("signupPassword").value
        }) });
        $("signupPassword").value = "";
        lockOtpStarts(result.retryAfter);
        showOtp(result, "signup");
    });
});

$("loginForm").addEventListener("submit", (event) => {
    event.preventDefault();
    withForm(event.currentTarget, "Signing in…", async () => {
        const result = await api("/api/auth/login", { method: "POST", body: JSON.stringify({
            mobile: mobileValue("loginMobile"), password: $("loginPassword").value
        }) });
        $("loginPassword").value = "";
        await enterAccount(result.user);
    });
});

$("verifyForm").addEventListener("submit", (event) => {
    event.preventDefault();
    withForm(event.currentTarget, "Verifying…", async () => {
        if (!pendingOtp) throw new Error("Go back and request a new OTP.");
        const reset = pendingOtp.purpose === "reset";
        if (reset && $("newPassword").value !== $("confirmPassword").value) throw new Error("The two passwords do not match.");
        const mobile = pendingOtp.mobile;
        const result = await api(reset ? "/api/auth/password/reset" : "/api/auth/signup/verify", {
            method: "POST", body: JSON.stringify({ challengeId: pendingOtp.challengeId, code: $("verificationCode").value.trim(),
                ...(reset ? { password: $("newPassword").value } : {}) })
        });
        clearOtp();
        $("loginMobile").value = mobile;
        showScreen("loginScreen");
        notice("authNotice", result.message, "success");
        $("loginPassword").focus();
    });
});

$("resendButton").addEventListener("click", async () => {
    $("resendButton").disabled = true;
    try {
        if (!pendingOtp) throw new Error("Go back and request a new OTP.");
        const result = await api("/api/auth/otp/resend", { method: "POST", body: JSON.stringify({ challengeId: pendingOtp.challengeId }) });
        notice("authNotice", result.message, "success");
        startResendCountdown(result.retryAfter);
    } catch (error) {
        notice("authNotice", friendlyError(error), "error");
        if (error.retryAfter) startResendCountdown(error.retryAfter);
        else $("resendButton").disabled = false;
    }
});

$("forgotForm").addEventListener("submit", (event) => {
    event.preventDefault();
    withForm(event.currentTarget, "Sending OTP…", async () => {
        const result = await api("/api/auth/password/start", { method: "POST", body: JSON.stringify({ mobile: mobileValue("forgotMobile") }) });
        lockOtpStarts(result.retryAfter);
        showOtp(result, "reset");
    });
});

$("logoutButton").addEventListener("click", () => signOut().catch((error) => notice("chatNotice", friendlyError(error), "error")));
$("chatForm").addEventListener("submit", sendMessage);
$("messageInput").addEventListener("input", updateComposer);
$("messageInput").addEventListener("keydown", (event) => {
    if (event.key === "Enter" && !event.shiftKey && !event.isComposing) { event.preventDefault(); $("chatForm").requestSubmit(); }
});
document.querySelectorAll("[data-prompt]").forEach((button) => button.addEventListener("click", () => {
    $("messageInput").value = button.dataset.prompt;
    updateComposer();
    $("messageInput").focus();
}));
$("newChatButton").addEventListener("click", newChat);
$("openSidebar").addEventListener("click", () => { setSidebar(true); $("closeSidebar").focus(); });
$("closeSidebar").addEventListener("click", () => { setSidebar(false); $("openSidebar").focus(); });
$("sidebarBackdrop").addEventListener("click", () => setSidebar(false));
document.addEventListener("keydown", (event) => { if (event.key === "Escape") setSidebar(false); });
$("olderButton").addEventListener("click", () => openConversation(selectedChat, true));
$("moreChatsButton").addEventListener("click", async () => {
    $("moreChatsButton").disabled = true;
    try { await refreshConversations(true); } catch (error) { notice("chatNotice", friendlyError(error), "error"); }
    finally { $("moreChatsButton").disabled = false; }
});
$("renameButton").addEventListener("click", () => openAction("rename"));
$("deleteButton").addEventListener("click", () => openAction("delete"));
$("dialogCancel").addEventListener("click", () => $("actionDialog").close());
$("actionForm").addEventListener("submit", async (event) => {
    event.preventDefault();
    $("dialogConfirm").disabled = true;
    const id = selectedChat;
    try {
        if (dialogAction === "rename") {
            const result = await api(`/api/conversations/${id}`, { method: "PATCH", body: JSON.stringify({ title: $("renameInput").value.trim() }) });
            setTitle(result.conversation.title);
        } else {
            await api(`/api/conversations/${id}`, { method: "DELETE" });
            newChat();
        }
        $("actionDialog").close();
        await refreshConversations();
    } catch (error) {
        if ($("actionDialog").open) $("dialogError").textContent = friendlyError(error);
        else notice("chatNotice", friendlyError(error), "error");
    } finally { $("dialogConfirm").disabled = false; }
});

async function initialize() {
    try {
        config = await api("/api/config");
        if (!config.configured) throw new Error("Setup needed: copy .env.example to .env, add SUPABASE_URL and SUPABASE_SECRET_KEY, run supabase/setup.sql, then restart. Follow README.md.");
        for (const id of ["loginMobile", "signupMobile", "forgotMobile"]) $(id).placeholder = `${config.defaultCountryCode} followed by your number`;
        try {
            const result = await api("/api/auth/session");
            if (result.user) await enterAccount(result.user);
            else showScreen("loginScreen");
        } catch (error) {
            if (error.status !== 401) throw error;
            showScreen("loginScreen");
        }
        if (!config.otpConfigured) {
            $("signupForm").querySelector("button[type=submit]").disabled = true;
            $("forgotForm").querySelector("button[type=submit]").disabled = true;
            notice("authNotice", "Mobile verification needs 2Factor setup. Add TWOFACTOR_API_KEY to .env and restart. Existing accounts can still sign in.", "error");
        }
    } catch (error) {
        showScreen("loginScreen");
        notice("authNotice", friendlyError(error), "error");
        if (!config?.configured) document.querySelectorAll(".auth-screen button[type=submit], #resendButton").forEach((button) => { button.disabled = true; });
    }
}

function updateOtpStarts() {
    const remaining = Math.max(0, Math.ceil((otpStartUntil - Date.now()) / 1000));
    for (const id of ["signupForm", "forgotForm"]) {
        const button = $(id).querySelector("button[type=submit]");
        if (!button.dataset.idleLabel) button.dataset.idleLabel = id === "signupForm" ? "Send verification OTP →" : "Send reset OTP →";
        const busy = $(id).dataset.busy === "true";
        button.disabled = busy || remaining > 0 || config?.otpConfigured === false || config?.configured === false;
        if (!busy) button.textContent = remaining ? `Try again in ${remaining}s` : button.dataset.idleLabel;
    }
    if (!remaining) clearInterval(otpStartTimer);
}
function lockOtpStarts(seconds) {
    otpStartUntil = Math.max(otpStartUntil, Date.now() + seconds * 1000);
    clearInterval(otpStartTimer);
    updateOtpStarts();
    otpStartTimer = setInterval(updateOtpStarts, 1000);
}

function setImageMode(enabled) {
    imageMode = enabled;
    $("imageStudio").classList.toggle("hidden", !enabled);
    $("chatScroll").classList.toggle("hidden", enabled);
    $("composerArea").classList.toggle("hidden", enabled);
    $("imageStudioButton").classList.toggle("selected", enabled);
    $("chatTitle").textContent = enabled ? "Image studio" : (conversations.find((item) => item.id === selectedChat)?.title || "A new conversation");
    $("renameButton").classList.toggle("hidden", enabled || !selectedChat);
    $("deleteButton").classList.toggle("hidden", enabled || !selectedChat);
    setSidebar(false);
}
function renderImages() {
    $("imageGallery").replaceChildren();
    $("imageEmpty").classList.toggle("hidden", imageItems.length > 0);
    for (const item of imageItems) {
        const card = document.createElement("article");
        card.className = "image-card";
        const picture = document.createElement("img");
        picture.src = item.url;
        picture.alt = item.prompt;
        picture.loading = "lazy";
        picture.addEventListener("error", () => { picture.alt = "Image unavailable. Refresh the gallery or sign in again."; });
        const caption = document.createElement("p"); caption.textContent = item.prompt;
        const actions = document.createElement("div"); actions.className = "image-card-actions";
        const download = document.createElement("a");
        download.className = "text-btn"; download.textContent = "Download";
        download.href = item.downloadUrl; download.download = "";
        const remove = document.createElement("button");
        remove.type = "button"; remove.className = "text-btn delete-image"; remove.textContent = "Delete";
        remove.addEventListener("click", async () => {
            if (!window.confirm("Delete this generated image permanently?")) return;
            const generation = accountGeneration;
            remove.disabled = true;
            try {
                await api(`/api/images/${item.id}`, { method: "DELETE" });
                if (generation !== accountGeneration) return;
                imageItems = imageItems.filter((row) => row.id !== item.id); renderImages();
            } catch (error) { if (generation === accountGeneration) notice("imageNotice", friendlyError(error), "error"); }
            finally { remove.disabled = false; }
        });
        actions.append(download, remove); card.append(picture, caption, actions); $("imageGallery").append(card);
    }
}
async function refreshImages() {
    const generation = accountGeneration;
    const request = ++imageListRequest;
    const result = await api("/api/images");
    if (generation !== accountGeneration || request !== imageListRequest) return;
    imageItems = result.images; renderImages();
}
$("imageStudioButton").addEventListener("click", async () => {
    setImageMode(true); notice("imageNotice");
    $("generateImageButton").disabled = imageWorking || !config.imageConfigured;
    const generation = accountGeneration;
    if (!config.imageConfigured) notice("imageNotice", "Image generation is not configured. Contact the app owner.", "error");
    try { await refreshImages(); }
    catch (error) { if (generation === accountGeneration) notice("imageNotice", friendlyError(error), "error"); }
});
$("refreshImagesButton").addEventListener("click", async () => {
    const generation = accountGeneration;
    try { await refreshImages(); notice("imageNotice"); }
    catch (error) { if (generation === accountGeneration) notice("imageNotice", friendlyError(error), "error"); }
});
$("imageForm").addEventListener("submit", async (event) => {
    event.preventDefault();
    if (imageWorking) return;
    const prompt = $("imagePrompt").value.trim();
    const aspectRatio = $("imageRatio").value;
    if (!prompt || prompt.length > 2000) return;
    const generation = accountGeneration;
    if (!imageAttempt || imageAttempt.prompt !== prompt || imageAttempt.aspectRatio !== aspectRatio) {
        imageAttempt = { requestId: crypto.randomUUID(), prompt, aspectRatio };
    }
    imageWorking = true; $("generateImageButton").disabled = true;
    $("imageLoading").classList.remove("hidden"); notice("imageNotice");
    try {
        const result = await api("/api/images", { method: "POST", body: JSON.stringify(imageAttempt), timeoutMs: 240000 });
        if (generation !== accountGeneration) return;
        imageListRequest++;
        imageItems = [result.image, ...imageItems.filter((item) => item.id !== result.image.id)];
        imageAttempt = null; renderImages();
        notice("imageNotice", "Your image is ready and saved to your private gallery.", "success");
    } catch (error) {
        if (generation === accountGeneration) notice("imageNotice", friendlyError(error), "error");
    } finally {
        if (generation === accountGeneration) {
            imageWorking = false; $("generateImageButton").disabled = !config.imageConfigured;
            $("imageLoading").classList.add("hidden");
        }
    }
});
initialize();
