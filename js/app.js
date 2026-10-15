
/* =========================================================
   TALKATCH — app.js
   Requires:
   1. config.js loaded before this file
   2. Supabase JS v2 loaded in your HTML
   3. Matching Supabase tables and RLS policies
========================================================= */

(() => {
  "use strict";

  const config = window.TALKATCH_CONFIG;

  if (!config?.supabaseUrl || !config?.supabasePublishableKey) {
    console.error("TALKATCH: Missing Supabase configuration in config.js");
    return;
  }

  if (!window.supabase?.createClient) {
    console.error("TALKATCH: Supabase JS library is missing.");
    return;
  }

  const db = window.supabase.createClient(
    config.supabaseUrl,
    config.supabasePublishableKey,
    {
      auth: {
        persistSession: true,
        autoRefreshToken: true,
        detectSessionInUrl: true
      }
    }
  );

  window.talkatchDB = db;

  const $ = (selector) => document.querySelector(selector);
  const $$ = (selector) => [...document.querySelectorAll(selector)];

  const state = {
    user: null,
    profile: null,
    busy: false
  };

  const redirectURL = window.location.origin + "/";

  /* -------------------- UI HELPERS -------------------- */

  function showMessage(message, type = "info") {
    let box = $("#app-message");

    if (!box) {
      box = document.createElement("div");
      box.id = "app-message";
      box.setAttribute("role", "status");
      box.style.cssText = [
        "position:fixed",
        "left:50%",
        "bottom:22px",
        "transform:translateX(-50%)",
        "z-index:99999",
        "max-width:90%",
        "padding:13px 18px",
        "border-radius:12px",
        "font:14px system-ui,sans-serif",
        "box-shadow:0 8px 30px #0004"
      ].join(";");

      document.body.appendChild(box);
    }

    box.textContent = message;
    box.style.background =
      type === "error" ? "#7f1d1d" :
      type === "success" ? "#14532d" : "#27272a";
    box.style.color = "#fff";
    box.style.display = "block";

    clearTimeout(showMessage.timer);
    showMessage.timer = setTimeout(() => {
      box.style.display = "none";
    }, 6000);
  }

  function setBusy(form, busy) {
    if (!form) return;

    form.querySelectorAll(
      'button[type="submit"], input[type="submit"]'
    ).forEach((button) => {
      button.disabled = busy;
    });
  }

  function value(form, ...names) {
    for (const name of names) {
      const field = form?.querySelector(
        `[name="${name}"], #${CSS.escape(name)}`
      );

      if (field && typeof field.value === "string") {
        return field.value.trim();
      }
    }

    return "";
  }

  function setText(selector, text) {
    const element = $(selector);
    if (element) element.textContent = text ?? "";
  }

  function toggle(selector, visible) {
    const element = $(selector);
    if (element) {
      element.hidden = !visible;
    }
  }

  function escapeHTML(input) {
    return String(input ?? "").replace(/[&<>"']/g, (character) => ({
      "&": "&amp;",
      "<": "&lt;",
      ">": "&gt;",
      '"': "&quot;",
      "'": "&#39;"
    })[character]);
  }

  function friendlyError(error) {
    const message = error?.message || "Something went wrong.";

    if (/invalid login credentials/i.test(message)) {
      return "Incorrect email or password.";
    }

    if (/email not confirmed/i.test(message)) {
      return "Please confirm your email before logging in.";
    }

    if (/user already registered/i.test(message)) {
      return "This email is already registered. Try logging in.";
    }

    if (/rate limit/i.test(message)) {
      return "Too many attempts. Please wait before trying again.";
    }

    return message;
  }

  /* -------------------- AUTHENTICATION -------------------- */

  async function signUp(event) {
    event?.preventDefault();

    const form = event?.currentTarget || $("#signupForm");
    if (!form || state.busy) return;

    const username = value(form, "username");
    const email = value(form, "email").toLowerCase();
    const password = value(form, "password");

    if (!/^[a-zA-Z0-9_]{3,24}$/.test(username)) {
      showMessage(
        "Username must be 3–24 characters using letters, numbers, or underscores.",
        "error"
      );
      return;
    }

    if (!/^[^\s@]+@[^\s@]+\.[^\s@]+$/.test(email)) {
      showMessage("Enter a valid email address.", "error");
      return;
    }

    if (password.length < 8) {
      showMessage("Password must be at least 8 characters.", "error");
      return;
    }

    state.busy = true;
    setBusy(form, true);

    try {
      const { data, error } = await db.auth.signUp({
        email,
        password,
        options: {
          emailRedirectTo: redirectURL,
          data: {
            username,
            display_name: username
          }
        }
      });

      if (error) throw error;

      /*
       * A database trigger should create profiles automatically.
       * If email confirmation is enabled, there may be no session yet.
       */
      if (data.user && data.session) {
        await ensureProfile(data.user, username);
        showMessage("Account created successfully!", "success");
        await initializeApp(data.session);
      } else {
        showMessage(
          "Account submitted. Check your email and click the confirmation link before logging in.",
          "success"
        );
      }
    } catch (error) {
      console.error("Signup failed:", error);
      showMessage(friendlyError(error), "error");
    } finally {
      state.busy = false;
      setBusy(form, false);
    }
  }

  async function logIn(event) {
    event?.preventDefault();

    const form = event?.currentTarget || $("#loginForm");
    if (!form || state.busy) return;

    const email = value(form, "email").toLowerCase();
    const password = value(form, "password");

    if (!email || !password) {
      showMessage("Enter your email and password.", "error");
      return;
    }

    state.busy = true;
    setBusy(form, true);

    try {
      const { data, error } = await db.auth.signInWithPassword({
        email,
        password
      });

      if (error) throw error;

      if (!data.session || !data.user) {
        throw new Error("Login succeeded but no session was returned.");
      }

      await initializeApp(data.session);
      showMessage("Welcome back!", "success");
    } catch (error) {
      console.error("Login failed:", error);
      showMessage(friendlyError(error), "error");
    } finally {
      state.busy = false;
      setBusy(form, false);
    }
  }

  async function logOut() {
    try {
      /*
       * Local scope signs out this browser session.
       * It does not delete the user's account or profile.
       */
      const { error } = await db.auth.signOut({ scope: "local" });

      if (error) throw error;

      state.user = null;
      state.profile = null;

      window.location.replace(redirectURL);
    } catch (error) {
      console.error("Logout failed:", error);
      showMessage(friendlyError(error), "error");
    }
  }

  async function resetPassword(event) {
    event?.preventDefault();

    const emailField = $("#resetEmail") || $('[name="email"]');
    const email = emailField?.value?.trim().toLowerCase();

    if (!email) {
      showMessage("Enter your email address first.", "error");
      return;
    }

    try {
      const { error } = await db.auth.resetPasswordForEmail(email, {
        redirectTo: redirectURL
      });

      if (error) throw error;

      showMessage("If the account exists, a password reset email has been requested.", "success");
    } catch (error) {
      console.error("Password reset failed:", error);
      showMessage(friendlyError(error), "error");
    }
  }

  /* -------------------- PROFILE -------------------- */

  async function ensureProfile(user, preferredUsername = "") {
    if (!user) return null;

    const metadata = user.user_metadata || {};
    const username =
      preferredUsername ||
      metadata.username ||
      (user.email ? user.email.split("@")[0] : "user");

    /*
     * Requires profiles.id to reference auth.users.id.
     * Do not overwrite existing profiles during login.
     */
    const { data: existing, error: findError } = await db
      .from("profiles")
      .select("*")
      .eq("id", user.id)
      .maybeSingle();

    if (findError) {
      console.error("Profile lookup failed:", findError);
      throw new Error(
        "Could not load your profile. Check the profiles table and its RLS policies."
      );
    }

    if (existing) return existing;

    const { data: created, error: createError } = await db
      .from("profiles")
      .insert({
        id: user.id,
        username,
        display_name: metadata.display_name || username,
        avatar_url: null,
        bio: ""
      })
      .select()
      .single();

    if (createError) {
      /*
       * A database trigger may have created the row between the
       * lookup and insert. Try loading it again before reporting failure.
       */
      const { data: retry } = await db
        .from("profiles")
        .select("*")
        .eq("id", user.id)
        .maybeSingle();

      if (retry) return retry;

      console.error("Profile creation failed:", createError);
      throw new Error(
        "Your login worked, but your profile could not be created. Check your profiles table and RLS policies."
      );
    }

    return created;
  }

  async function loadProfile() {
    if (!state.user) return null;

    const { data, error } = await db
      .from("profiles")
      .select("*")
      .eq("id", state.user.id)
      .maybeSingle();

    if (error) {
      console.error("Loading profile failed:", error);
      return null;
    }

    state.profile = data;

    setText("#profileUsername", data?.username || "");
    setText("#profileDisplayName", data?.display_name || data?.username || "");
    setText("#profileBio", data?.bio || "");

    const avatar = $("#profileAvatar");

    if (avatar && data?.avatar_url) {
      if (avatar.tagName === "IMG") {
        avatar.src = data.avatar_url;
      } else {
        avatar.style.backgroundImage = `url("${data.avatar_url}")`;
      }
    }

    return data;
  }

  async function saveProfile(event) {
    event?.preventDefault();

    if (!state.user) {
      showMessage("Please log in first.", "error");
      return;
    }

    const form = event?.currentTarget || $("#profileForm");
    if (!form) return;

    const username = value(form, "username");
    const displayName = value(form, "display_name", "displayName");
    const bio = value(form, "bio");

    if (username && !/^[a-zA-Z0-9_]{3,24}$/.test(username)) {
      showMessage("Username must be 3–24 letters, numbers, or underscores.", "error");
      return;
    }

    const updates = {
      bio,
      display_name: displayName || username || state.profile?.display_name
    };

    if (username) updates.username = username;

    const { data, error } = await db
      .from("profiles")
      .update(updates)
      .eq("id", state.user.id)
      .select()
      .single();

    if (error) {
      console.error("Saving profile failed:", error);
      showMessage(friendlyError(error), "error");
      return;
    }

    state.profile = data;
    showMessage("Profile saved.", "success");
    await loadProfile();
  }

  /* -------------------- FEED -------------------- */

  async function loadFeed() {
    const container = $("#feedList") || $("#postsList") || $("#feed");
    if (!container) return;

    const { data: posts, error } = await db
      .from("posts")
      .select(`
        id,
        user_id,
        content,
        created_at,
        profiles:user_id (username, display_name, avatar_url)
      `)
      .order("created_at", { ascending: false })
      .limit(50);

    if (error) {
      console.error("Loading feed failed:", error);
      container.textContent = "Unable to load posts. Check your posts table and RLS policies.";
      return;
    }

    if (!posts?.length) {
      container.textContent = "No posts yet. Be the first to share something!";
      return;
    }

    container.innerHTML = posts.map((post) => `
      <article class="talkatch-post" data-post-id="${escapeHTML(post.id)}">
        <header class="post-header">
          <strong>${escapeHTML(
            post.profiles?.display_name ||
            post.profiles?.username ||
            "User"
          )}</strong>
          <small>${escapeHTML(
            post.created_at ? new Date(post.created_at).toLocaleString() : ""
          )}</small>
        </header>
        <p>${escapeHTML(post.content)}</p>
        <div class="post-actions">
          <button type="button" data-action="like" data-id="${escapeHTML(post.id)}">Like</button>
          <button type="button" data-action="comments" data-id="${escapeHTML(post.id)}">Comments</button>
          <button type="button" data-action="follow" data-user="${escapeHTML(post.user_id)}">Follow</button>
        </div>
        <div class="post-comments" hidden></div>
      </article>
    `).join("");

    await loadLikeCounts(posts);
  }

  async function createPost(event) {
    event?.preventDefault();

    if (!state.user) {
      showMessage("Please log in to publish a post.", "error");
      return;
    }

    const form = event?.currentTarget || $("#postForm");
    const content = value(form, "content", "postContent");

    if (!content) {
      showMessage("Write something before publishing.", "error");
      return;
    }

    const { error } = await db.from("posts").insert({
      user_id: state.user.id,
      content
    });

    if (error) {
      console.error("Creating post failed:", error);
      showMessage(friendlyError(error), "error");
      return;
    }

    const field = form?.querySelector('[name="content"], #postContent');
    if (field) field.value = "";

    showMessage("Post published.", "success");
    await loadFeed();
  }

  /* -------------------- LIKES -------------------- */

  async function loadLikeCounts(posts) {
    if (!posts?.length) return;

    const ids = posts.map((post) => post.id);

    const { data, error } = await db
      .from("likes")
      .select("post_id,user_id")
      .in("post_id", ids);

    if (error) {
      console.warn("Like counts unavailable:", error.message);
      return;
    }

    const counts = {};
    const liked = new Set();

    for (const like of data || []) {
      counts[like.post_id] = (counts[like.post_id] || 0) + 1;

      if (like.user_id === state.user?.id) {
        liked.add(like.post_id);
      }
    }

    $$(".talkatch-post").forEach((article) => {
      const id = article.dataset.postId;
      const button = article.querySelector('[data-action="like"]');

      if (!button) return;

      button.textContent =
        `${liked.has(id) ? "Unlike" : "Like"} (${counts[id] || 0})`;

      button.dataset.liked = liked.has(id) ? "true" : "false";
    });
  }

  async function toggleLike(postId, button) {
    if (!state.user) {
      showMessage("Please log in to like posts.", "error");
      return;
    }

    const alreadyLiked = button?.dataset.liked === "true";

    if (alreadyLiked) {
      const { error } = await db
        .from("likes")
        .delete()
        .eq("post_id", postId)
        .eq("user_id", state.user.id);

      if (error) {
        showMessage(friendlyError(error), "error");
        return;
      }
    } else {
      const { error } = await db.from("likes").insert({
        post_id: postId,
        user_id: state.user.id
      });

      if (error && !/duplicate key/i.test(error.message)) {
        showMessage(friendlyError(error), "error");
        return;
      }
    }

    await loadFeed();
  }

  /* -------------------- COMMENTS -------------------- */

  async function loadComments(postId, article) {
    const container = article?.querySelector(".post-comments");
    if (!container) return;

    container.hidden = false;
    container.textContent = "Loading comments…";

    const { data, error } = await db
      .from("comments")
      .select(`
        id,
        content,
        created_at,
        user_id,
        profiles:user_id (username, display_name)
      `)
      .eq("post_id", postId)
      .order("created_at", { ascending: true });

    if (error) {
      console.error("Loading comments failed:", error);
      container.textContent = "Unable to load comments.";
      return;
    }

    container.innerHTML = `
      <div class="comment-list">
        ${(data || []).map((comment) => `
          <p>
            <strong>${escapeHTML(
              comment.profiles?.display_name ||
              comment.profiles?.username ||
              "User"
            )}</strong>
            ${escapeHTML(comment.content)}
          </p>
        `).join("")}
      </div>
      ${state.user ? `
        <form class="comment-form" data-post-id="${escapeHTML(postId)}">
          <input name="content" maxlength="2000" placeholder="Write a comment…" required>
          <button type="submit">Send</button>
        </form>
      ` : `<p>Log in to comment.</p>`}
    `;
  }

  async function createComment(event) {
    event.preventDefault();

    if (!state.user) {
      showMessage("Please log in to comment.", "error");
      return;
    }

    const form = event.target;
    const postId = form.dataset.postId;
    const content = value(form, "content");

    if (!content) return;

    const { error } = await db.from("comments").insert({
      post_id: postId,
      user_id: state.user.id,
      content
    });

    if (error) {
      showMessage(friendlyError(error), "error");
      return;
    }

    await loadComments(postId, form.closest(".talkatch-post"));
  }

  /* -------------------- FOLLOWS -------------------- */

  async function toggleFollow(targetUserId, button) {
    if (!state.user) {
      showMessage("Please log in to follow people.", "error");
      return;
    }

    if (targetUserId === state.user.id) {
      showMessage("You cannot follow yourself.", "error");
      return;
    }

    const { data: existing, error: lookupError } = await db
      .from("follows")
      .select("follower_id,following_id")
      .eq("follower_id", state.user.id)
      .eq("following_id", targetUserId)
      .maybeSingle();

    if (lookupError) {
      showMessage(friendlyError(lookupError), "error");
      return;
    }

    if (existing) {
      const { error } = await db
        .from("follows")
        .delete()
        .eq("follower_id", state.user.id)
        .eq("following_id", targetUserId);

      if (error) {
        showMessage(friendlyError(error), "error");
        return;
      }

      if (button) button.textContent = "Follow";
    } else {
      const { error } = await db.from("follows").insert({
        follower_id: state.user.id,
        following_id: targetUserId
      });

      if (error) {
        showMessage(friendlyError(error), "error");
        return;
      }

      if (button) button.textContent = "Following";
    }

    showMessage("Follow status updated.", "success");
  }

  /* -------------------- NOTIFICATIONS -------------------- */

  async function loadNotifications() {
    const container = $("#notificationsList") || $("#notificationList");
    if (!container || !state.user) return;

    const { data, error } = await db
      .from("notifications")
      .select("id,type,message,created_at,is_read")
      .eq("user_id", state.user.id)
      .order("created_at", { ascending: false })
      .limit(50);

    if (error) {
      console.warn("Notifications unavailable:", error.message);
      container.textContent = "Notifications are currently unavailable.";
      return;
    }

    if (!data?.length) {
      container.textContent = "No notifications yet.";
      return;
    }

    container.innerHTML = data.map((item) => `
      <article class="talkatch-notification">
        <p>${escapeHTML(item.message || item.type || "New notification")}</p>
        <small>${escapeHTML(
          item.created_at ? new Date(item.created_at).toLocaleString() : ""
        )}</small>
      </article>
    `).join("");
  }

  /* -------------------- DISCOVER PEOPLE -------------------- */

  async function loadPeople() {
    const container = $("#peopleList") || $("#discoverList");
    if (!container) return;

    const { data, error } = await db
      .from("profiles")
      .select("id,username,display_name,bio,avatar_url")
      .order("username")
      .limit(50);

    if (error) {
      console.error("Loading people failed:", error);
      container.textContent = "Unable to load people.";
      return;
    }

    const people = (data || []).filter(
      (person) => person.id !== state.user?.id
    );

    if (!people.length) {
      container.textContent = "No other users found yet.";
      return;
    }

    container.innerHTML = people.map((person) => `
      <article class="talkatch-person">
        <strong>${escapeHTML(person.display_name || person.username || "User")}</strong>
        <p>@${escapeHTML(person.username || "user")}</p>
        <p>${escapeHTML(person.bio || "")}</p>
        <button type="button" data-action="follow" data-user="${escapeHTML(person.id)}">
          Follow
        </button>
      </article>
    `).join("");
  }

  /* -------------------- APP INITIALIZATION -------------------- */

  async function initializeApp(session) {
    state.user = session?.user || null;

    if (!state.user) {
      state.profile = null;
      toggle("#authSection", true);
      toggle("#loginSection", true);
      toggle("#signupSection", false);
      toggle("#appSection", false);
      return;
    }

    toggle("#authSection", false);
    toggle("#appSection", true);

    setText("#currentUserEmail", state.user.email || "");

    try {
      state.profile = await loadProfile();

      if (!state.profile) {
        state.profile = await ensureProfile(state.user);
        await loadProfile();
      }

      await Promise.allSettled([
        loadFeed(),
        loadPeople(),
        loadNotifications()
      ]);
    } catch (error) {
      console.error("App initialization failed:", error);
      showMessage(error.message || "Unable to load your profile.", "error");
    }
  }

  /* -------------------- EVENT BINDINGS -------------------- */

  document.addEventListener("submit", (event) => {
    const form = event.target;

    if (form.matches("#signupForm, [data-form='signup']")) {
      signUp(event);
    } else if (form.matches("#loginForm, [data-form='login']")) {
      logIn(event);
    } else if (form.matches("#postForm, [data-form='post']")) {
      createPost(event);
    } else if (form.matches("#profileForm, [data-form='profile']")) {
      saveProfile(event);
    } else if (form.matches("#resetPasswordForm, [data-form='reset-password']")) {
      resetPassword(event);
    } else if (form.matches(".comment-form")) {
      createComment(event);
    }
  });

  document.addEventListener("click", async (event) => {
    const button = event.target.closest("button, [data-action]");
    if (!button) return;

    if (button.matches("#logoutBtn, [data-action='logout']")) {
      event.preventDefault();
      await logOut();
      return;
    }

    if (button.matches("#showSignup, [data-action='show-signup']")) {
      toggle("#loginSection", false);
      toggle("#signupSection", true);
      return;
    }

    if (button.matches("#showLogin, [data-action='show-login']")) {
      toggle("#signupSection", false);
      toggle("#loginSection", true);
      return;
    }

    const action = button.dataset.action;
    const postId = button.dataset.id;

    if (action === "like" && postId) {
      await toggleLike(postId, button);
    } else if (action === "comments" && postId) {
      const article = button.closest(".talkatch-post");
      const container = article?.querySelector(".post-comments");

      if (container && !container.hidden) {
        container.hidden = true;
      } else {
        await loadComments(postId, article);
      }
    } else if (action === "follow" && button.dataset.user) {
      await toggleFollow(button.dataset.user, button);
    } else if (action === "refresh-feed") {
      await loadFeed();
    } else if (action === "refresh-notifications") {
      await loadNotifications();
    }
  });

  /* -------------------- PASSWORD RECOVERY -------------------- */

  db.auth.onAuthStateChange((event, session) => {
    if (event === "PASSWORD_RECOVERY") {
      showMessage("Enter your new password to finish recovery.");
      toggle("#passwordUpdateForm", true);
    }
  });

  document.addEventListener("submit", async (event) => {
    const form = event.target;
    if (!form.matches("#passwordUpdateForm")) return;

    event.preventDefault();

    const password = value(form, "password", "newPassword");

    if (password.length < 8) {
      showMessage("Password must be at least 8 characters.", "error");
      return;
    }

    const { error } = await db.auth.updateUser({ password });

    if (error) {
      showMessage(friendlyError(error), "error");
      return;
    }

    showMessage("Password updated. You can now log in.", "success");
    await logOut();
  });

  /* -------------------- START -------------------- */

  async function start() {
    const { data, error } = await db.auth.getSession();

    if (error) {
      console.error("Session restoration failed:", error);
      showMessage("Unable to restore your session. Please log in again.", "error");
      return;
    }

    await initializeApp(data.session);

    /*
     * Listen for login/logout/refresh events.
     * Avoid doing heavy async work directly inside the auth callback.
     */
    db.auth.onAuthStateChange((event, session) => {
      if (event === "SIGNED_OUT") {
        state.user = null;
        state.profile = null;
        toggle("#authSection", true);
        toggle("#appSection", false);
      } else if (event === "SIGNED_IN" || event === "TOKEN_REFRESHED") {
        state.user = session?.user || null;
      }
    });
  }

  window.TALKATCH = {
    db,
    signUp,
    logIn,
    logOut,
    resetPassword,
    loadProfile,
    saveProfile,
    loadFeed,
    createPost,
    loadPeople,
    loadNotifications
  };

  start().catch((error) => {
    console.error("TALKATCH startup error:", error);
    showMessage("TALKATCH could not start. Check the browser console.", "error");
  });
})();
