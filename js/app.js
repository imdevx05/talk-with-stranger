
(() => {
  "use strict";

  const $ = id => document.getElementById(id);
  const config = window.TALKATCH_CONFIG;

  if (!config || !window.supabase) {
    console.error("TALKATCH config or Supabase library is missing.");
    return;
  }

  const db = window.supabase.createClient(
    config.supabaseUrl,
    config.supabasePublishableKey
  );

  const state = {
    user: null,
    profile: null,
    people: [],
    selected: null,
    conversationId: null,
    messageChannel: null,
    signalChannel: null,
    incomingOffer: null,
    pc: null,
    stream: null,
    pendingIce: [],
    seenSignals: new Set(),
    videoCall: false,
    pendingImage: null,
    toastTimer: null
  };

  const escapeHtml = value => String(value ?? "").replace(
    /[&<>"']/g,
    char => ({
      "&": "&amp;", "<": "&lt;", ">": "&gt;",
      '"': "&quot;", "'": "&#39;"
    })[char]
  );

  const initials = value => {
    const words = String(value || "T").trim().split(/\s+/);
    return words.slice(0, 2).map(word => word[0] || "").join("").toUpperCase();
  };

  const message = (id, text, isError = false) => {
    const element = $(id);
    if (!element) return;
    element.textContent = text || "";
    element.style.color = isError ? "var(--danger)" : "var(--muted)";
  };

  function toast(text) {
    const box = $("toast");
    box.textContent = text;
    box.classList.remove("hidden");
    clearTimeout(state.toastTimer);
    state.toastTimer = setTimeout(() => box.classList.add("hidden"), 3500);
  }

  function avatarMarkup(profile) {
    const name = profile?.display_name || profile?.username || "Member";
    if (profile?.avatar_url) {
      return `<img class="avatar" src="${escapeHtml(profile.avatar_url)}" alt="">`;
    }
    return `<div class="avatar">${escapeHtml(initials(name))}</div>`;
  }

  function setView(name) {
    document.querySelectorAll(".view").forEach(view => view.classList.add("hidden"));
    const view = $("view-" + name);
    if (view) view.classList.remove("hidden");

    document.querySelectorAll(".nav-item[data-view]").forEach(button => {
      button.classList.toggle("active", button.dataset.view === name);
    });

    if (name === "people") loadPeople();
    if (name === "messages") loadPeople();
    if (name === "admin") loadAdmin();
  }

  function setAuthMode(mode) {
    $("login-form").classList.toggle("hidden", mode !== "login");
    $("signup-form").classList.toggle("hidden", mode !== "signup");

    document.querySelectorAll("[data-auth-tab]").forEach(button => {
      button.classList.toggle("active", button.dataset.authTab === mode);
    });

    message("auth-status", "");
  }

  async function loadProfile() {
    const { data, error } = await db.from("profiles")
      .select("id,username,display_name,avatar_url,role,is_suspended")
      .eq("id", state.user.id)
      .maybeSingle();

    if (error) throw error;

    if (!data) {
      const username = (state.user.email || "member")
        .split("@")[0].replace(/[^A-Za-z0-9_]/g, "").slice(0, 24) || "member";

      const { data: created, error: createError } = await db
        .from("profiles")
        .insert({
          id: state.user.id,
          username: username + "_" + state.user.id.slice(0, 5),
          display_name: username
        })
        .select("id,username,display_name,avatar_url,role,is_suspended")
        .single();

      if (createError) throw createError;
      state.profile = created;
    } else {
      state.profile = data;
    }

    if (state.profile.is_suspended) {
      await db.auth.signOut();
      throw new Error("This account has been suspended. Contact the administrator.");
    }

    $("my-name").textContent = state.profile.display_name || state.profile.username;
    $("my-username").textContent = "@" + state.profile.username;
    $("my-avatar").textContent = initials(state.profile.display_name || state.profile.username);
    $("user-label").textContent = state.profile.display_name || state.profile.username;
    $("stat-account").textContent = state.profile.role === "admin" ? "Administrator" : "Member";
    $("admin-nav").classList.toggle("hidden", state.profile.role !== "admin");

    if (state.profile.avatar_url) {
      $("my-avatar").innerHTML = "";
      $("my-avatar").style.backgroundImage = `url("${state.profile.avatar_url}")`;
      $("my-avatar").style.backgroundSize = "cover";
      $("my-avatar").textContent = "";
    }
  }

  async function showApp() {
    $("auth-view").classList.add("hidden");
    $("app-view").classList.remove("hidden");
    $("logout-btn").classList.remove("hidden");
    await loadProfile();
    await loadPeople();
    await subscribeIncomingCalls();
  }

  function showAuth() {
    $("auth-view").classList.remove("hidden");
    $("app-view").classList.add("hidden");
    $("logout-btn").classList.add("hidden");
    state.user = null;
    state.profile = null;
    closeConversation();
    endCall(false);
  }

  async function authLogin(event) {
    event.preventDefault();
    const email = $("login-email").value.trim();
    const password = $("login-password").value;
    message("auth-status", "Signing in…");

    const { data, error } = await db.auth.signInWithPassword({ email, password });
    if (error) return message("auth-status", error.message, true);

    state.user = data.user;
    try {
      await showApp();
      setView("home");
      message("auth-status", "");
    } catch (err) {
      message("auth-status", err.message, true);
    }
  }

  async function authSignup(event) {
    event.preventDefault();
    const display_name = $("signup-name").value.trim();
    const username = $("signup-username").value.trim();
    const email = $("signup-email").value.trim();
    const password = $("signup-password").value;

    if (!/^[A-Za-z0-9_]{3,24}$/.test(username)) {
      return message("auth-status", "Use 3–24 letters, numbers, or underscores.", true);
    }

    message("auth-status", "Creating account…");

    const { data, error } = await db.auth.signUp({
      email, password,
      options: { data: { display_name, username } }
    });

    if (error) return message("auth-status", error.message, true);

    if (!data.session) {
      return message("auth-status", "Account created. Confirm your email, then log in.");
    }

    state.user = data.user;
    try {
      await showApp();
      setView("home");
      toast("Welcome to TALKATCH!");
    } catch (err) {
      message("auth-status", err.message, true);
    }
  }

  async function loadPeople() {
    if (!state.user) return;

    const search = ($("people-search")?.value || $("chat-search")?.value || "")
      .trim().replace(/[%,()]/g, "");

    let query = db.from("profiles")
      .select("id,username,display_name,avatar_url,role")
      .neq("id", state.user.id)
      .eq("is_suspended", false)
      .order("username")
      .limit(100);

    if (search) {
      query = query.or(
        `username.ilike.%${search}%,display_name.ilike.%${search}%`
      );
    }

    const { data, error } = await query;
    if (error) {
      if ($("people-list")) $("people-list").innerHTML =
        `<div class="panel welcome-panel">Could not load people: ${escapeHtml(error.message)}</div>`;
      return;
    }

    state.people = data || [];
    renderPeople();
    renderContacts();
  }

  function renderPeople() {
    const container = $("people-list");
    if (!container) return;

    if (!state.people.length) {
      container.innerHTML = '<div class="panel welcome-panel">No members found.</div>';
      return;
    }

    container.innerHTML = state.people.map(person => `
      <article class="panel person-card">
        ${avatarMarkup(person)}
        <div class="person-details">
          <strong>${escapeHtml(person.display_name || person.username)}</strong>
          <p class="muted small">@${escapeHtml(person.username)}</p>
        </div>
        <div class="person-actions">
          <button class="btn btn-primary" data-start-chat="${escapeHtml(person.id)}" type="button">Add Message</button>
          <button class="btn btn-outline" data-report-user="${escapeHtml(person.id)}" type="button">Report</button>
        </div>
      </article>
    `).join("");
  }

  function renderContacts() {
    const container = $("chat-contacts-list");
    if (!container) return;

    container.innerHTML = state.people.map(person => `
      <button class="contact-item ${state.selected?.id === person.id ? "active" : ""}"
        data-start-chat="${escapeHtml(person.id)}" type="button">
        ${avatarMarkup(person)}
        <span class="contact-label">
          <strong>${escapeHtml(person.display_name || person.username)}</strong>
          <small>@${escapeHtml(person.username)}</small>
        </span>
      </button>
    `).join("") || '<p class="muted small">No other members found.</p>';
  }

  async function startChat(userId) {
    const person = state.people.find(item => item.id === userId);
    if (!person) {
      await loadPeople();
    }

    const target = state.people.find(item => item.id === userId);
    if (!target) return toast("That member could not be found.");

    closeConversation();
    state.selected = target;

    $("chat-title").textContent = target.display_name || target.username;
    $("chat-subtitle").textContent = "@" + target.username;
    $("message-input").disabled = false;
    $("send-message").disabled = false;
    $("voice-call").disabled = false;
    $("video-call").disabled = false;
    setView("messages");
    renderContacts();
    $("chat-messages").innerHTML = '<p class="muted">Opening conversation…</p>';

    const { data, error } = await db.rpc("create_direct_conversation", {
      other_user: target.id
    });

    if (error) {
      $("chat-messages").textContent = "Could not open chat: " + error.message;
      return;
    }

    state.conversationId = data;
    await loadMessages();
    subscribeMessages();
    await subscribeSignals();
    toast("Conversation ready.");
  }

  function closeConversation() {
    if (state.messageChannel) db.removeChannel(state.messageChannel);
    if (state.signalChannel) db.removeChannel(state.signalChannel);
    state.messageChannel = null;
    state.signalChannel = null;
    state.conversationId = null;
    state.selected = null;
    state.seenSignals.clear();
    state.pendingIce = [];

    if ($("chat-title")) $("chat-title").textContent = "Choose someone";
    if ($("chat-subtitle")) $("chat-subtitle").textContent = "Your private conversation";
    if ($("chat-messages")) $("chat-messages").innerHTML =
      '<div class="empty-chat"><span>✉</span><h3>Your conversations</h3><p class="muted">Select a person to start chatting.</p></div>';

    ["message-input", "send-message", "voice-call", "video-call"].forEach(id => {
      if ($(id)) $(id).disabled = true;
    });
  }

  async function loadMessages() {
    const cid = state.conversationId;
    if (!cid) return;

    const { data, error } = await db.from("messages")
      .select("id,conversation_id,sender_id,content,image_path,created_at")
      .eq("conversation_id", cid)
      .order("created_at", { ascending: true })
      .limit(200);

    if (error) {
      $("chat-messages").textContent = "Could not load messages: " + error.message;
      return;
    }

    $("chat-messages").innerHTML = "";
    for (const item of data || []) await renderMessage(item);
    scrollMessages();
  }

  async function signedImageUrl(path) {
    if (!path) return null;
    const { data, error } = await db.storage.from("chat-images")
      .createSignedUrl(path, 900);
    if (error) {
      console.warn("Unable to create image URL:", error.message);
      return null;
    }
    return data.signedUrl;
  }

  async function renderMessage(item) {
    const container = $("chat-messages");
    if (container.querySelector(`[data-message-id="${item.id}"]`)) return;

    const bubble = document.createElement("article");
    bubble.className = "message" + (item.sender_id === state.user.id ? " mine" : "");
    bubble.dataset.messageId = item.id;

    const content = document.createElement("div");
    content.className = "message-content";
    content.textContent = item.content || "";
    bubble.appendChild(content);

    if (item.image_path) {
      const url = await signedImageUrl(item.image_path);
      if (url) {
        const img = document.createElement("img");
        img.className = "message-image";
        img.src = url;
        img.alt = "Shared picture";
        img.loading = "lazy";
        bubble.appendChild(img);
      } else {
        const unavailable = document.createElement("p");
        unavailable.className = "muted small";
        unavailable.textContent = "Picture unavailable or access expired.";
        bubble.appendChild(unavailable);
      }
    }

    const meta = document.createElement("div");
    meta.className = "message-meta";
    const who = document.createElement("span");
    who.textContent = item.sender_id === state.user.id
      ? "You" : (state.selected?.display_name || state.selected?.username || "Member");
    const time = document.createElement("time");
    time.textContent = new Date(item.created_at).toLocaleTimeString([], {
      hour: "2-digit", minute: "2-digit"
    });
    meta.append(who, time);
    bubble.appendChild(meta);
    container.appendChild(bubble);
    scrollMessages();
  }

  function scrollMessages() {
    const container = $("chat-messages");
    if (container) container.scrollTop = container.scrollHeight;
  }

  function subscribeMessages() {
    if (state.messageChannel) db.removeChannel(state.messageChannel);

    const cid = state.conversationId;
    state.messageChannel = db.channel("talkatch-messages-" + cid)
      .on("postgres_changes", {
        event: "INSERT", schema: "public", table: "messages",
        filter: `conversation_id=eq.${cid}`
      }, async event => {
        await renderMessage(event.new);
      })
      .subscribe();
  }

  async function sendMessage(event) {
    event.preventDefault();

    if (!state.conversationId || !state.selected) {
      return message("chat-status", "Choose a person first.", true);
    }

    const content = $("message-input").value.trim();
    const file = state.pendingImage;

    if (!content && !file) {
      return message("chat-status", "Write a message or attach a picture.", true);
    }

    let image_path = null;

    if (file) {
      if (!/^image\/(jpeg|png|webp|gif)$/.test(file.type) || file.size > 5 * 1024 * 1024) {
        return message("chat-status", "Choose a JPG, PNG, WebP, or GIF under 5 MB.", true);
      }

      const safeName = file.name.replace(/[^A-Za-z0-9._-]/g, "_");
      image_path = `${state.conversationId}/${state.user.id}/${crypto.randomUUID()}-${safeName}`;

      message("chat-status", "Uploading picture…");
      const { error: uploadError } = await db.storage.from("chat-images")
        .upload(image_path, file, { contentType: file.type, upsert: false });

      if (uploadError) return message("chat-status", uploadError.message, true);
    }

    const { error } = await db.from("messages").insert({
      conversation_id: state.conversationId,
      sender_id: state.user.id,
      content,
      image_path
    });

    if (error) {
      message("chat-status", error.message, true);
      return;
    }

    $("message-input").value = "";
    $("message-image").value = "";
    $("image-preview").innerHTML = "";
    $("image-preview").classList.add("hidden");
    state.pendingImage = null;
    message("chat-status", "Sent.");
    await loadMessages();
  }

  function selectImage(event) {
    const file = event.target.files?.[0];
    if (!file) return;

    if (!/^image\/(jpeg|png|webp|gif)$/.test(file.type) || file.size > 5 * 1024 * 1024) {
      event.target.value = "";
      state.pendingImage = null;
      return toast("Choose an image under 5 MB.");
    }

    state.pendingImage = file;
    const url = URL.createObjectURL(file);
    $("image-preview").innerHTML =
      `<img src="${url}" alt="Selected picture"><button id="remove-image" type="button" class="text-btn">Remove</button>`;
    $("image-preview").classList.remove("hidden");
    $("remove-image").addEventListener("click", () => {
      state.pendingImage = null;
      $("message-image").value = "";
      $("image-preview").innerHTML = "";
      $("image-preview").classList.add("hidden");
      URL.revokeObjectURL(url);
    });
  }

  async function reportUser(userId) {
    const reason = prompt("Why are you reporting this user?");
    if (!reason || reason.trim().length < 3) return;

    const { error } = await db.rpc("submit_user_report", {
      target_user: userId,
      report_reason: reason.trim()
    });

    if (error) toast("Could not submit report: " + error.message);
    else toast("Report sent to the moderation team.");
  }

  // ---------------- WEBRTC CALLS ----------------

  async function makePeerConnection(video) {
    if (state.pc) state.pc.close();

    state.videoCall = video;
    state.pendingIce = [];
    state.stream = await navigator.mediaDevices.getUserMedia({
      audio: true, video
    });

    state.pc = new RTCPeerConnection({
      iceServers: [
        { urls: "stun:stun.l.google.com:19302" }
      ]
    });

    state.stream.getTracks().forEach(track => state.pc.addTrack(track, state.stream));
    $("video-stage").classList.remove("hidden");
    $("local-video").srcObject = state.stream;
    $("local-video").style.display = video ? "block" : "none";
    $("remote-video").srcObject = null;

    state.pc.ontrack = event => {
      $("remote-video").srcObject = event.streams[0];
    };

    state.pc.onicecandidate = event => {
      if (event.candidate) {
        sendSignal("ice", { candidate: event.candidate.toJSON() }).catch(console.error);
      }
    };

    state.pc.onconnectionstatechange = () => {
      const connection = state.pc?.connectionState;
      if (connection === "connected") message("chat-status", "Call connected.");
      if (connection === "failed") message("chat-status", "Call failed. A TURN server may be required.", true);
    };
  }

  async function sendSignal(type, payload = {}) {
    if (!state.conversationId || !state.selected) throw new Error("Choose a contact first.");

    const { error } = await db.from("call_signals").insert({
      conversation_id: state.conversationId,
      sender_id: state.user.id,
      recipient_id: state.selected.id,
      signal_type: type,
      payload
    });

    if (error) throw error;
  }

  async function startCall(video) {
    if (!state.selected || !state.conversationId) return toast("Choose a person first.");

    try {
      await makePeerConnection(video);
      const offer = await state.pc.createOffer();
      await state.pc.setLocalDescription(offer);
      await sendSignal("offer", {
        type: offer.type,
        sdp: offer.sdp,
        video
      });

      $("end-call").classList.remove("hidden");
      message("chat-status", "Calling " + (state.selected.display_name || state.selected.username) + "…");
    } catch (error) {
      endCall(false);
      message("chat-status", "Call could not start: " + error.message, true);
    }
  }

  async function subscribeSignals() {
    if (state.signalChannel) db.removeChannel(state.signalChannel);

    const cid = state.conversationId;
    state.signalChannel = db.channel("talkatch-signals-" + cid)
      .on("postgres_changes", {
        event: "INSERT", schema: "public", table: "call_signals",
        filter: `recipient_id=eq.${state.user.id}`
      }, event => {
        if (event.new.conversation_id === cid) receiveSignal(event.new);
      })
      .subscribe();
  }

  async function subscribeIncomingCalls() {
    // This lightweight listener announces calls in any conversation.
    // Accepting a call requires opening its conversation first.
    db.channel("talkatch-incoming-" + state.user.id)
      .on("postgres_changes", {
        event: "INSERT", schema: "public", table: "call_signals",
        filter: `recipient_id=eq.${state.user.id}`
      }, event => {
        const signal = event.new;
        if (signal.signal_type !== "offer" || signal.conversation_id === state.conversationId) return;
        toast("Incoming call. Open that person's chat to answer.");
      })
      .subscribe();
  }

  async function receiveSignal(signal) {
    if (state.seenSignals.has(signal.id)) return;
    state.seenSignals.add(signal.id);

    try {
      if (signal.signal_type === "offer") {
        state.incomingOffer = signal;
        $("call-banner-text").textContent =
          "Incoming " + (signal.payload.video ? "video" : "voice") + " call from " +
          (state.selected?.display_name || state.selected?.username || "member");
        $("call-banner").classList.remove("hidden");
      } else if (signal.signal_type === "answer" && state.pc) {
        await state.pc.setRemoteDescription({
          type: "answer", sdp: signal.payload.sdp
        });
        await drainIce();
      } else if (signal.signal_type === "ice" && state.pc && signal.payload.candidate) {
        const candidate = new RTCIceCandidate(signal.payload.candidate);
        if (state.pc.remoteDescription) await state.pc.addIceCandidate(candidate);
        else state.pendingIce.push(candidate);
      } else if (signal.signal_type === "hangup" || signal.signal_type === "decline") {
        endCall(false);
        message("chat-status", signal.signal_type === "hangup" ? "Call ended." : "Call declined.");
      }
    } catch (error) {
      message("chat-status", "Call signaling error: " + error.message, true);
    }
  }

  async function drainIce() {
    if (!state.pc?.remoteDescription) return;
    for (const candidate of state.pendingIce) {
      await state.pc.addIceCandidate(candidate);
    }
    state.pendingIce = [];
  }

  async function acceptCall() {
    const offer = state.incomingOffer;
    if (!offer || !state.selected || offer.sender_id !== state.selected.id) {
      return toast("Open the caller's conversation first.");
    }

    try {
      await makePeerConnection(Boolean(offer.payload.video));
      await state.pc.setRemoteDescription({
        type: "offer", sdp: offer.payload.sdp
      });
      await drainIce();

      const answer = await state.pc.createAnswer();
      await state.pc.setLocalDescription(answer);
      await sendSignal("answer", { type: answer.type, sdp: answer.sdp });

      $("call-banner").classList.add("hidden");
      $("end-call").classList.remove("hidden");
      message("chat-status", "Connecting call…");
      state.incomingOffer = null;
    } catch (error) {
      message("chat-status", "Could not answer: " + error.message, true);
    }
  }

  async function declineCall() {
    if (state.incomingOffer && state.selected) {
      try { await sendSignal("decline"); } catch (_) {}
    }
    state.incomingOffer = null;
    $("call-banner").classList.add("hidden");
  }

  async function endCall(notify = true) {
    if (notify && state.selected && state.conversationId && state.pc) {
      try { await sendSignal("hangup"); } catch (_) {}
    }

    if (state.pc) state.pc.close();
    state.pc = null;

    if (state.stream) state.stream.getTracks().forEach(track => track.stop());
    state.stream = null;

    $("local-video").srcObject = null;
    $("remote-video").srcObject = null;
    $("video-stage").classList.add("hidden");
    $("end-call").classList.add("hidden");
    $("call-banner").classList.add("hidden");
    state.pendingIce = [];
  }

  // ---------------- ADMIN PANEL ----------------

  async function loadAdmin() {
    if (state.profile?.role !== "admin") {
      setView("home");
      return toast("Administrator access required.");
    }

    const [usersResult, reportsResult] = await Promise.all([
      db.rpc("admin_list_users"),
      db.rpc("admin_list_reports")
    ]);

    if (usersResult.error || reportsResult.error) {
      $("admin-users-list").textContent =
        "Admin query failed. Verify the Supabase admin functions and role.";
      $("admin-reports-list").textContent = "";
      return;
    }

    const users = usersResult.data || [];
    const reports = reportsResult.data || [];
    $("admin-member-count").textContent = users.length;
    $("admin-report-count").textContent = reports.filter(r => r.status === "open").length;

    renderAdminUsers(users);
    renderAdminReports(reports);
  }

  function renderAdminUsers(users) {
    const search = $("admin-user-search").value.trim().toLowerCase();
    const filtered = users.filter(user =>
      `${user.username} ${user.display_name} ${user.role}`.toLowerCase().includes(search)
    );

    $("admin-users-list").innerHTML = filtered.map(user => `
      <div class="admin-row">
        <div>
          <strong>${escapeHtml(user.display_name || user.username)}</strong>
          <p class="muted small">@${escapeHtml(user.username)} · ${escapeHtml(user.role)}</p>
          <p class="small">${user.is_suspended ? "Suspended" : "Active"}</p>
        </div>
        <div class="admin-actions">
          ${user.id !== state.user.id && user.role !== "admin" ? `
            <button class="btn ${user.is_suspended ? "btn-primary" : "btn-danger"}"
              data-suspend="${escapeHtml(user.id)}"
              data-next="${user.is_suspended ? "false" : "true"}" type="button">
              ${user.is_suspended ? "Restore" : "Suspend"}
            </button>` : ""}
        </div>
      </div>
    `).join("") || '<p class="muted">No members found.</p>';
  }

  function renderAdminReports(reports) {
    $("admin-reports-list").innerHTML = reports.map(report => `
      <div class="report-item">
        <div class="admin-row">
          <div>
            <strong>Report · ${escapeHtml(report.status)}</strong>
            <p>${escapeHtml(report.reason)}</p>
            <p class="muted small">Reported user: ${escapeHtml(report.reported_username || report.reported_user_id)}</p>
            <p class="muted small">${escapeHtml(new Date(report.created_at).toLocaleString())}</p>
          </div>
          <div class="admin-actions">
            ${report.status === "open" ? `
              <button class="btn btn-outline" data-report-status="${escapeHtml(report.id)}" data-next-status="reviewing" type="button">Review</button>
              <button class="btn btn-primary" data-report-status="${escapeHtml(report.id)}" data-next-status="resolved" type="button">Resolve</button>
              <button class="btn btn-outline" data-report-status="${escapeHtml(report.id)}" data-next-status="dismissed" type="button">Dismiss</button>
            ` : ""}
          </div>
        </div>
      </div>
    `).join("") || '<p class="muted">No reports yet.</p>';
  }

  async function suspendUser(userId, suspended) {
    const confirmText = suspended ? "Suspend this member?" : "Restore this member?";
    if (!confirm(confirmText)) return;

    const { error } = await db.rpc("admin_set_suspension", {
      target_user: userId,
      suspended
    });

    if (error) toast("Could not update member: " + error.message);
    else {
      toast(suspended ? "Member suspended." : "Member restored.");
      await loadAdmin();
    }
  }

  async function updateReport(reportId, status) {
    const { error } = await db.rpc("admin_update_report", {
      target_report: reportId,
      new_status: status
    });

    if (error) toast("Could not update report: " + error.message);
    else {
      toast("Report updated.");
      await loadAdmin();
    }
  }

  function bindEvents() {
    $("login-form").addEventListener("submit", authLogin);
    $("signup-form").addEventListener("submit", authSignup);

    document.querySelectorAll("[data-auth-tab]").forEach(button => {
      button.addEventListener("click", () => setAuthMode(button.dataset.authTab));
    });

    $("forgot-password").addEventListener("click", async () => {
      const email = $("login-email").value.trim();
      if (!email) return message("auth-status", "Enter your email address first.", true);
      const { error } = await db.auth.resetPasswordForEmail(email);
      message("auth-status", error ? error.message : "Password reset email requested.", Boolean(error));
    });

    $("logout-btn").addEventListener("click", async () => {
      await endCall(false);
      await db.auth.signOut();
      showAuth();
    });

    $("theme-toggle").addEventListener("click", () => {
      document.body.dataset.theme =
        document.body.dataset.theme === "dark" ? "light" : "dark";
    });

    document.querySelectorAll("[data-view]").forEach(button => {
      button.addEventListener("click", () => setView(button.dataset.view));
    });

    document.querySelectorAll("[data-go]").forEach(button => {
      button.addEventListener("click", () => setView(button.dataset.go));
    });

    $("people-search").addEventListener("input", loadPeople);
    $("chat-search").addEventListener("input", loadPeople);
    $("admin-user-search").addEventListener("input", loadAdmin);
    $("message-form").addEventListener("submit", sendMessage);
    $("message-image").addEventListener("change", selectImage);
    $("voice-call").addEventListener("click", () => startCall(false));
    $("video-call").addEventListener("click", () => startCall(true));
    $("end-call").addEventListener("click", () => endCall(true));
    $("accept-call").addEventListener("click", acceptCall);
    $("decline-call").addEventListener("click", declineCall);

    document.body.addEventListener("click", async event => {
      const chatButton = event.target.closest("[data-start-chat]");
      if (chatButton) {
        const id = chatButton.dataset.startChat;
        setView("messages");
        await startChat(id);
        return;
      }

      const reportButton = event.target.closest("[data-report-user]");
      if (reportButton) {
        await reportUser(reportButton.dataset.reportUser);
        return;
      }

      const suspendButton = event.target.closest("[data-suspend]");
      if (suspendButton) {
        await suspendUser(suspendButton.dataset.suspend, suspendButton.dataset.next === "true");
        return;
      }

      const reportStatusButton = event.target.closest("[data-report-status]");
      if (reportStatusButton) {
        await updateReport(reportStatusButton.dataset.reportStatus, reportStatusButton.dataset.nextStatus);
      }
    });

    $("year").textContent = new Date().getFullYear();
  }

  async function init() {
    bindEvents();

    const { data, error } = await db.auth.getSession();
    if (error) {
      message("auth-status", error.message, true);
      return;
    }

    if (data.session?.user) {
      state.user = data.session.user;
      try {
        await showApp();
        setView("home");
      } catch (err) {
        message("auth-status", err.message, true);
      }
    } else {
      showAuth();
    }

    db.auth.onAuthStateChange((event, session) => {
      if (event === "SIGNED_OUT") showAuth();
      else if (event === "SIGNED_IN" && session?.user && !state.user) {
        state.user = session.user;
        showApp().catch(err => message("auth-status", err.message, true));
      }
    });
  }

  if (document.readyState === "loading") {
    document.addEventListener("DOMContentLoaded", init, { once: true });
  } else {
    init();
  }
})();
