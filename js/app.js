(() => {
  "use strict";

  // =========================================================
  // TALKATCH — FULL FRONTEND APPLICATION
  // Requires Supabase JS v2, config.js, and the matching SQL.
  // =========================================================

  const CONFIG = window.TALKATCH_CONFIG || {};
  const $ = (selector, root = document) => root.querySelector(selector);
  const $$ = (selector, root = document) => [...root.querySelectorAll(selector)];

  const supabaseUrl = CONFIG.supabaseUrl;
  const supabaseKey = CONFIG.supabaseAnonKey;

  if (!window.supabase || !supabaseUrl || !supabaseKey ||
      supabaseKey.includes("YOUR_SUPABASE")) {
    console.error("TALKATCH: Configure the Supabase URL and public key in config.js.");
    const message = $("#auth-message");
    if (message) {
      message.textContent =
        "Setup required: add your Supabase public key to config.js.";
    }
    return;
  }

  const db = window.supabase.createClient(supabaseUrl, supabaseKey);

  const state = {
    user: null,
    profile: null,
    activePerson: null,
    activeView: "feed",
    profiles: [],
    posts: [],
    postImage: null,
    messageChannel: null,
    messageSubscription: null,
    heartbeat: null,
    realtimeFeed: null,
    realtimeNotifications: null,
    searchTimer: null,
    toastTimer: null,
    loadingMessages: false,
    theme: localStorage.getItem("talkatch-theme") || "light"
  };

  const AVATAR_FALLBACK =
    "https://api.dicebear.com/9.x/initials/svg?seed=TALKATCH";

  // =========================================================
  // UTILITIES
  // =========================================================

  function escapeHTML(value = "") {
    return String(value).replace(/[&<>"']/g, character => ({
      "&": "&amp;",
      "<": "&lt;",
      ">": "&gt;",
      '"': "&quot;",
      "'": "&#39;"
    })[character]);
  }

  function avatarURL(profile) {
    return profile?.avatar_url || AVATAR_FALLBACK;
  }

  function initials(profile) {
    const name = profile?.display_name || profile?.username || "Member";
    return name.trim().slice(0, 2).toUpperCase();
  }

  function timeAgo(value) {
    const date = new Date(value);
    if (Number.isNaN(date.getTime())) return "";

    const seconds = Math.max(0, (Date.now() - date.getTime()) / 1000);

    if (seconds < 60) return "Just now";
    if (seconds < 3600) return `${Math.floor(seconds / 60)}m ago`;
    if (seconds < 86400) return `${Math.floor(seconds / 3600)}h ago`;
    if (seconds < 604800) return `${Math.floor(seconds / 86400)}d ago`;

    return date.toLocaleDateString();
  }

  function isOnline(profile) {
    if (!profile?.last_seen_at) return false;

    return Date.now() - new Date(profile.last_seen_at).getTime() < 90000;
  }

  function toast(message, duration = 3200) {
    const element = $("#toast");
    if (!element) {
      console.log(message);
      return;
    }

    element.textContent = message;
    element.classList.remove("hidden");

    clearTimeout(state.toastTimer);
    state.toastTimer = setTimeout(() => {
      element.classList.add("hidden");
    }, duration);
  }

  function setAuthMessage(message, error = false) {
    const element = $("#auth-message");
    if (!element) return;

    element.textContent = message;
    element.style.color = error ? "#dc3545" : "";
  }

  function setBusy(form, busy) {
    if (!form) return;

    $$('button[type="submit"]', form).forEach(button => {
      button.disabled = busy;

      if (busy) {
        button.dataset.originalText ||= button.textContent;
        button.textContent = "Please wait…";
      } else if (button.dataset.originalText) {
        button.textContent = button.dataset.originalText;
      }
    });
  }

  function showAuth(show) {
    $("#auth-view")?.classList.toggle("hidden", !show);
    $("#app-view")?.classList.toggle("hidden", show);
  }

  function displayName(profile) {
    return profile?.display_name || profile?.username || "Member";
  }

  function normalizeUsername(value) {
    return value.trim().toLowerCase();
  }

  function validateUsername(value) {
    return /^[a-zA-Z0-9_]{3,24}$/.test(value);
  }

  function currentUserId() {
    return state.user?.id || null;
  }

  async function getOwnProfile() {
    if (!state.user) return null;

    const { data, error } = await db
      .from("profiles")
      .select("*")
      .eq("id", state.user.id)
      .maybeSingle();

    if (error) throw error;
    return data;
  }

  async function ensureProfile() {
    if (!state.user) return null;

    let profile = await getOwnProfile();

    if (profile) {
      state.profile = profile;
      return profile;
    }

    const metadata = state.user.user_metadata || {};
    let username = normalizeUsername(
      metadata.username ||
      (state.user.email || "member").split("@")[0]
    ).replace(/[^a-z0-9_]/g, "").slice(0, 24);

    if (username.length < 3) {
      username = "user_" + state.user.id.replace(/-/g, "").slice(0, 8);
    }

    // The trigger in the SQL normally creates this profile.
    // This is a fallback if a profile has not yet been created.
    const { data, error } = await db
      .from("profiles")
      .insert({
        id: state.user.id,
        username,
        display_name: String(
          metadata.display_name || username
        ).slice(0, 60)
      })
      .select("*")
      .single();

    if (error) {
      // Another request or the signup trigger may have created it.
      profile = await getOwnProfile().catch(() => null);
      if (profile) {
        state.profile = profile;
        return profile;
      }
      throw error;
    }

    state.profile = data;
    return data;
  }

  async function uploadFile(bucket, file, folder, maxBytes) {
    if (!file) return null;

    if (file.size > maxBytes) {
      throw new Error(
        `File is too large. Maximum size is ${Math.floor(maxBytes / 1024 / 1024)} MB.`
      );
    }

    const allowedTypes = [
      "image/jpeg",
      "image/png",
      "image/webp"
    ];

    if (bucket !== "message-files" &&
        !allowedTypes.includes(file.type)) {
      throw new Error("Please choose a JPG, PNG, or WebP image.");
    }

    const safeName = file.name
      .replace(/[^a-zA-Z0-9._-]/g, "_")
      .slice(-100);

    const path = `${folder}/${Date.now()}-${safeName}`;

    const { error } = await db.storage
      .from(bucket)
      .upload(path, file, {
        upsert: false,
        contentType: file.type || "application/octet-stream"
      });

    if (error) throw error;

    if (bucket === "message-files") {
      return {
        path,
        name: file.name,
        type: file.type || "application/octet-stream",
        size: file.size
      };
    }

    const { data } = db.storage.from(bucket).getPublicUrl(path);

    return {
      path,
      url: data.publicUrl
    };
  }

  function setImage(element, url, alt = "") {
    if (!element) return;

    element.src = url || AVATAR_FALLBACK;
    element.alt = alt;
    element.onerror = () => {
      element.onerror = null;
      element.src = AVATAR_FALLBACK;
    };
  }

  function setTheme(theme) {
    state.theme = theme;
    document.documentElement.dataset.theme = theme;
    document.body.dataset.theme = theme;
    localStorage.setItem("talkatch-theme", theme);

    const button = $("#theme-button");
    if (button) {
      button.textContent =
        theme === "dark" ? "Switch to light mode" : "Switch to dark mode";
    }
  }

  function updateMyProfileUI() {
    const profile = state.profile;
    if (!profile) return;

    const name = displayName(profile);
    const handle = "@" + (profile.username || "member");
    const image = avatarURL(profile);

    setImage($("#my-avatar"), image, name);
    setImage($("#composer-avatar"), image, name);
    setImage($("#profile-avatar"), image, name);

    if ($("#my-name")) $("#my-name").textContent = name;
    if ($("#my-handle")) $("#my-handle").textContent = handle;

    if ($("#profile-name")) $("#profile-name").textContent = name;
    if ($("#profile-handle")) $("#profile-handle").textContent = handle;
    if ($("#profile-bio")) {
      $("#profile-bio").textContent = profile.bio || "No bio yet.";
    }

    if ($("#edit-display-name")) {
      $("#edit-display-name").value = profile.display_name || "";
    }
    if ($("#edit-username")) {
      $("#edit-username").value = profile.username || "";
    }
    if ($("#edit-bio")) {
      $("#edit-bio").value = profile.bio || "";
    }
  }

  // =========================================================
  // AUTHENTICATION
  // =========================================================

  function switchAuthTab(tab) {
    const isLogin = tab === "login";

    $("#login-form")?.classList.toggle("hidden", !isLogin);
    $("#signup-form")?.classList.toggle("hidden", isLogin);

    $$(".auth-tab").forEach(button => {
      button.classList.toggle("active", button.dataset.tab === tab);
    });

    if ($("#auth-title")) {
      $("#auth-title").textContent =
        isLogin ? "Welcome back" : "Create your account";
    }

    const description = $(".auth-description");
    if (description) {
      description.textContent = isLogin
        ? "Sign in to continue to TALKATCH."
        : "Join TALKATCH and start connecting.";
    }

    setAuthMessage("");
  }

  async function login(event) {
    event.preventDefault();

    const form = event.currentTarget;
    const email = $("#login-email").value.trim();
    const password = $("#login-password").value;

    setBusy(form, true);
    setAuthMessage("");

    try {
      const { data, error } = await db.auth.signInWithPassword({
        email,
        password
      });

      if (error) throw error;

      if (data.user && !data.session) {
        setAuthMessage("Please confirm your email before logging in.", true);
        return;
      }

      toast("Welcome back!");
      await enterApp(data.user);
    } catch (error) {
      setAuthMessage(error.message || "Unable to log in.", true);
    } finally {
      setBusy(form, false);
    }
  }

  async function signup(event) {
    event.preventDefault();

    const form = event.currentTarget;
    const display_name = $("#signup-name").value.trim();
    const username = normalizeUsername($("#signup-username").value);
    const email = $("#signup-email").value.trim();
    const password = $("#signup-password").value;

    if (!validateUsername(username)) {
      setAuthMessage(
        "Username must be 3–24 characters and use only letters, numbers, and underscores.",
        true
      );
      return;
    }

    if (display_name.length < 1 || display_name.length > 60) {
      setAuthMessage("Enter a display name between 1 and 60 characters.", true);
      return;
    }

    setBusy(form, true);
    setAuthMessage("");

    try {
      // Check username availability before signup.
      const { data: existing, error: lookupError } = await db
        .from("profiles")
        .select("id")
        .eq("username", username)
        .maybeSingle();

      if (lookupError) throw lookupError;

      if (existing) {
        throw new Error("That username is already taken.");
      }

      const { data, error } = await db.auth.signUp({
        email,
        password,
        options: {
          emailRedirectTo: window.location.origin,
          data: {
            username,
            display_name
          }
        }
      });

      if (error) throw error;

      if (data.session && data.user) {
        // Supabase may return a session immediately if confirmation is off.
        await enterApp(data.user);
        toast("Your account has been created.");
      } else {
        setAuthMessage(
          "Account submitted. Check your email and click the confirmation link before logging in."
        );
        form.reset();
        switchAuthTab("login");
        setAuthMessage(
          "Account submitted. Check your email and click the confirmation link before logging in."
        );
      }
    } catch (error) {
      setAuthMessage(error.message || "Unable to create your account.", true);
    } finally {
      setBusy(form, false);
    }
  }

  async function forgotPassword() {
    const email = $("#login-email")?.value.trim();

    if (!email) {
      setAuthMessage("Enter your email address first.", true);
      $("#login-email")?.focus();
      return;
    }

    try {
      const { error } = await db.auth.resetPasswordForEmail(email, {
        redirectTo: window.location.origin
      });

      if (error) throw error;

      setAuthMessage(
        "If the account exists, a password-reset email will be sent. Check your inbox."
      );
    } catch (error) {
      setAuthMessage(error.message || "Unable to request password reset.", true);
    }
  }

  async function logout() {
    try {
      await stopPresence();

      if (state.messageSubscription) {
        await db.removeChannel(state.messageSubscription);
        state.messageSubscription = null;
      }

      if (state.realtimeFeed) {
        await db.removeChannel(state.realtimeFeed);
        state.realtimeFeed = null;
      }

      if (state.realtimeNotifications) {
        await db.removeChannel(state.realtimeNotifications);
        state.realtimeNotifications = null;
      }

      if (state.messageChannel) {
        await db.removeChannel(state.messageChannel);
        state.messageChannel = null;
      }

      const { error } = await db.auth.signOut();
      if (error) throw error;

      state.user = null;
      state.profile = null;
      state.activePerson = null;
      state.posts = [];

      showAuth(true);
      switchAuthTab("login");
      toast("You have logged out.");
    } catch (error) {
      toast(error.message || "Unable to log out.");
    }
  }

  // =========================================================
  // APP ENTRY AND PRESENCE
  // =========================================================

  async function enterApp(user) {
    if (!user) {
      showAuth(true);
      return;
    }

    state.user = user;
    showAuth(false);

    try {
      await ensureProfile();
      updateMyProfileUI();

      await updatePresence();
      startPresence();

      await Promise.allSettled([
        loadFeed(),
        loadPeople(),
        loadMyPosts(),
        loadNotifications()
      ]);

      await loadConversationList();
      setupRealtime();

      switchView("feed");
    } catch (error) {
      console.error("TALKATCH initialization:", error);
      toast(error.message || "Some account information could not be loaded.");
    }
  }

  async function updatePresence() {
    if (!state.user) return;

    const { error } = await db
      .from("profiles")
      .update({ last_seen_at: new Date().toISOString() })
      .eq("id", state.user.id);

    if (error) {
      console.warn("Presence update:", error.message);
    }
  }

  function startPresence() {
    clearInterval(state.heartbeat);

    state.heartbeat = setInterval(() => {
      if (state.user && document.visibilityState === "visible") {
        updatePresence();
      }
    }, 30000);
  }

  async function stopPresence() {
    clearInterval(state.heartbeat);
    state.heartbeat = null;

    if (state.user) {
      await db.from("profiles")
        .update({ last_seen_at: null })
        .eq("id", state.user.id);
    }
  }

  // =========================================================
  // NAVIGATION
  // =========================================================

  const viewDescriptions = {
    feed: ["Your feed", "See what people are sharing."],
    profile: ["My profile", "Customize your identity on TALKATCH."],
    people: ["Discover people", "Find members and follow their updates."],
    messages: ["Messages", "Continue your conversations."],
    notifications: ["Notifications", "See activity related to your account."],
    about: ["About TALKATCH", "A social space for connecting and sharing."]
  };

  function switchView(view) {
    const validViews = [
      "feed",
      "profile",
      "people",
      "messages",
      "notifications",
      "about"
    ];

    if (!validViews.includes(view)) return;

    state.activeView = view;

    $$(".app-view").forEach(section => {
      section.classList.toggle("hidden", section.id !== `${view}-view`);
    });

    $$(".sidebar-link, .mobile-nav-item").forEach(button => {
      button.classList.toggle("active", button.dataset.view === view);
    });

    const description = viewDescriptions[view];

    if ($("#page-title")) $("#page-title").textContent = description[0];
    if ($("#page-subtitle")) $("#page-subtitle").textContent = description[1];

    if (view === "feed") loadFeed();
    if (view === "people") loadPeople($("#user-search")?.value || "");
    if (view === "profile") loadMyPosts();
    if (view === "messages") loadConversationList();
    if (view === "notifications") loadNotifications();
  }

  // =========================================================
  // PEOPLE AND FOLLOWING
  // =========================================================

  async function loadPeople(search = "") {
    if (!state.user) return;

    const container = $("#people-list");
    if (!container) return;

    container.innerHTML = '<div class="empty-state">Loading people…</div>';

    try {
      let query = db
        .from("profiles")
        .select("id,username,display_name,bio,avatar_url,last_seen_at")
        .neq("id", state.user.id)
        .order("display_name", { ascending: true })
        .limit(100);

      const { data, error } = await query;
      if (error) throw error;

      const term = search.trim().toLowerCase();

      const people = (data || []).filter(person => {
        if (!term) return true;

        return (
          (person.username || "").toLowerCase().includes(term) ||
          (person.display_name || "").toLowerCase().includes(term)
        );
      });

      state.profiles = people;

      if (!people.length) {
        container.innerHTML = `
          <div class="empty-state">
            <h3>No people found</h3>
            <p>Try a different name or username.</p>
          </div>`;
        return;
      }

      const { data: follows, error: followError } = await db
        .from("follows")
        .select("following_id")
        .eq("follower_id", state.user.id);

      if (followError) throw followError;

      const followedIds = new Set((follows || []).map(item => item.following_id));

      container.innerHTML = people.map(person => `
        <article class="person" data-person-id="${escapeHTML(person.id)}">
          <img class="avatar" src="${escapeHTML(avatarURL(person))}"
            alt="${escapeHTML(displayName(person))}">
          <div class="user-details">
            <strong class="user-name">${escapeHTML(displayName(person))}</strong>
            <span class="user-handle">@${escapeHTML(person.username)}</span>
            <span class="presence-label">
              ${isOnline(person) ? "Online" : "Offline"}
            </span>
          </div>
          <div class="person-actions">
            <button class="btn btn-secondary" type="button"
              data-action="follow"
              data-user-id="${escapeHTML(person.id)}">
              ${followedIds.has(person.id) ? "Following" : "Follow"}
            </button>
            <button class="btn btn-primary" type="button"
              data-action="message"
              data-user-id="${escapeHTML(person.id)}">
              Message
            </button>
          </div>
        </article>
      `).join("");
    } catch (error) {
      console.error("People:", error);
      container.innerHTML = `
        <div class="empty-state">
          <h3>Unable to load people</h3>
          <p>${escapeHTML(error.message)}</p>
        </div>`;
    }
  }

  async function toggleFollow(targetId, button) {
    if (!state.user || targetId === state.user.id) return;

    const wasFollowing = button.textContent.trim() === "Following";
    button.disabled = true;

    try {
      if (wasFollowing) {
        const { error } = await db
          .from("follows")
          .delete()
          .eq("follower_id", state.user.id)
          .eq("following_id", targetId);

        if (error) throw error;

        button.textContent = "Follow";
        toast("You unfollowed this person.");
      } else {
        const { error } = await db
          .from("follows")
          .insert({
            follower_id: state.user.id,
            following_id: targetId
          });

        if (error) throw error;

        button.textContent = "Following";

        await createNotification(
          targetId,
          "follow",
          `${displayName(state.profile)} started following you.`
        );

        toast("You are now following this person.");
      }

      await loadPeople($("#user-search")?.value || "");
    } catch (error) {
      toast(error.message || "Unable to update follow status.");
    } finally {
      button.disabled = false;
    }
  }

  // =========================================================
  // FEED AND POSTS
  // =========================================================

  async function loadFeed() {
    if (!state.user) return;

    const container = $("#feed-list");
    if (!container) return;

    container.innerHTML = '<div class="empty-state">Loading posts…</div>';

    try {
      const { data: posts, error } = await db
        .from("posts")
        .select("*")
        .order("created_at", { ascending: false })
        .limit(50);

      if (error) throw error;

      state.posts = posts || [];

      if (!state.posts.length) {
        container.innerHTML = `
          <div class="empty-state">
            <h3>It's quiet here</h3>
            <p>Be the first to share something with the community.</p>
          </div>`;
        return;
      }

      const userIds = [...new Set(state.posts.map(post => post.user_id))];
      const postIds = state.posts.map(post => post.id);

      const [profileResult, likesResult, commentsResult, myLikesResult] =
        await Promise.all([
          db.from("profiles")
            .select("id,username,display_name,avatar_url")
            .in("id", userIds),
          db.from("likes")
            .select("post_id,user_id")
            .in("post_id", postIds),
          db.from("comments")
            .select("id,post_id,user_id,content,created_at")
            .in("post_id", postIds)
            .order("created_at", { ascending: true }),
          db.from("likes")
            .select("post_id")
            .eq("user_id", state.user.id)
            .in("post_id", postIds)
        ]);

      if (profileResult.error) throw profileResult.error;
      if (likesResult.error) throw likesResult.error;
      if (commentsResult.error) throw commentsResult.error;
      if (myLikesResult.error) throw myLikesResult.error;

      const profileMap = new Map(
        (profileResult.data || []).map(profile => [profile.id, profile])
      );

      const likeCounts = {};
      (likesResult.data || []).forEach(like => {
        likeCounts[like.post_id] = (likeCounts[like.post_id] || 0) + 1;
      });

      const commentGroups = {};
      (commentsResult.data || []).forEach(comment => {
        (commentGroups[comment.post_id] ||= []).push(comment);
      });

      const likedIds = new Set((myLikesResult.data || []).map(item => item.post_id));

      container.innerHTML = state.posts.map(post => {
        const author = profileMap.get(post.user_id) || {};
        const comments = commentGroups[post.id] || [];
        const mine = post.user_id === state.user.id;

        return renderPost(post, author, {
          likeCount: likeCounts[post.id] || 0,
          liked: likedIds.has(post.id),
          comments,
          profileMap,
          mine
        });
      }).join("");
    } catch (error) {
      console.error("Feed:", error);
      container.innerHTML = `
        <div class="empty-state">
          <h3>Unable to load feed</h3>
          <p>${escapeHTML(error.message)}</p>
        </div>`;
    }
  }

  function renderPost(post, author, details) {
    const {
      likeCount = 0,
      liked = false,
      comments = [],
      profileMap = new Map(),
      mine = false
    } = details || {};

    const commentHTML = comments.map(comment => {
      const commentAuthor = profileMap.get(comment.user_id) || {};
      return `
        <div class="comment-item">
          <img class="avatar avatar-sm"
            src="${escapeHTML(avatarURL(commentAuthor))}"
            alt="">
          <div class="comment-content">
            <strong>${escapeHTML(displayName(commentAuthor))}</strong>
            <p>${escapeHTML(comment.content)}</p>
            <small>${escapeHTML(timeAgo(comment.created_at))}</small>
          </div>
        </div>`;
    }).join("");

    const imageHTML = post.image_url
      ? `<img class="post-image" src="${escapeHTML(post.image_url)}"
          alt="Image shared in a post" loading="lazy">`
      : "";

    return `
      <article class="post-card" data-post-id="${escapeHTML(post.id)}">
        <header class="post-header">
          <img class="avatar" src="${escapeHTML(avatarURL(author))}"
            alt="${escapeHTML(displayName(author))}">
          <div class="post-author">
            <strong>${escapeHTML(displayName(author))}</strong>
            <span>@${escapeHTML(author.username || "member")} ·
              ${escapeHTML(timeAgo(post.created_at))}</span>
          </div>
          ${mine ? `
            <button class="btn btn-ghost post-menu" type="button"
              data-action="edit-post" data-post-id="${escapeHTML(post.id)}">
              Edit
            </button>
            <button class="btn btn-ghost post-menu" type="button"
              data-action="delete-post" data-post-id="${escapeHTML(post.id)}">
              Delete
            </button>` : ""}
        </header>

        <div class="post-body">
          ${post.content
            ? `<p class="post-text">${escapeHTML(post.content).replace(/\n/g, "<br>")}</p>`
            : ""}
          ${imageHTML}
        </div>

        <div class="post-stats">
          <span>${likeCount} ${likeCount === 1 ? "like" : "likes"}</span>
          <span>${comments.length} ${comments.length === 1 ? "comment" : "comments"}</span>
        </div>

        <div class="post-actions">
          <button class="post-action ${liked ? "liked" : ""}" type="button"
            data-action="like" data-post-id="${escapeHTML(post.id)}">
            ${liked ? "Liked" : "Like"}
          </button>
          <button class="post-action" type="button"
            data-action="focus-comment" data-post-id="${escapeHTML(post.id)}">
            Comment
          </button>
        </div>

        <div class="post-comments">
          ${commentHTML}
          <form class="comment-form" data-post-id="${escapeHTML(post.id)}">
            <input name="content" maxlength="500"
              placeholder="Write a comment…" required>
            <button class="btn btn-secondary" type="submit">Send</button>
          </form>
        </div>
      </article>`;
  }

  async function publishPost(event) {
    event.preventDefault();
    if (!state.user) return;

    const content = $("#post-content").value.trim();
    const file = $("#post-image")?.files?.[0];

    if (!content && !file) {
      toast("Write something or choose an image.");
      return;
    }

    const form = event.currentTarget;
    setBusy(form, true);

    try {
      let imageURL = null;

      if (file) {
        const uploaded = await uploadFile(
          "post-media",
          file,
          state.user.id,
          8 * 1024 * 1024
        );
        imageURL = uploaded.url;
      }

      const { error } = await db.from("posts").insert({
        user_id: state.user.id,
        content,
        image_url: imageURL
      });

      if (error) throw error;

      form.reset();
      state.postImage = null;
      $("#post-image-preview")?.classList.add("hidden");

      toast("Your post has been published.");
      await Promise.all([loadFeed(), loadMyPosts()]);
    } catch (error) {
      toast(error.message || "Unable to publish your post.");
    } finally {
      setBusy(form, false);
    }
  }

  async function toggleLike(postId, button) {
    if (!state.user) return;

    button.disabled = true;

    try {
      const { data: existing, error: findError } = await db
        .from("likes")
        .select("post_id")
        .eq("post_id", postId)
        .eq("user_id", state.user.id)
        .maybeSingle();

      if (findError) throw findError;

      if (existing) {
        const { error } = await db
          .from("likes")
          .delete()
          .eq("post_id", postId)
          .eq("user_id", state.user.id);

        if (error) throw error;
      } else {
        const { error } = await db
          .from("likes")
          .insert({
            post_id: postId,
            user_id: state.user.id
          });

        if (error) throw error;

        const post = state.posts.find(item => item.id === postId);

        if (post && post.user_id !== state.user.id) {
          await createNotification(
            post.user_id,
            "like",
            `${displayName(state.profile)} liked your post.`,
            postId
          );
        }
      }

      await loadFeed();
    } catch (error) {
      toast(error.message || "Unable to update like.");
    } finally {
      button.disabled = false;
    }
  }

  async function addComment(event) {
    event.preventDefault();
    if (!state.user) return;

    const form = event.currentTarget;
    const postId = form.dataset.postId;
    const input = $('input[name="content"]', form);
    const content = input?.value.trim();

    if (!content) return;

    const button = $('button[type="submit"]', form);
    if (button) button.disabled = true;

    try {
      const { error } = await db.from("comments").insert({
        post_id: postId,
        user_id: state.user.id,
        content
      });

      if (error) throw error;

      const post = state.posts.find(item => item.id === postId);

      if (post && post.user_id !== state.user.id) {
        await createNotification(
          post.user_id,
          "comment",
          `${displayName(state.profile)} commented on your post.`,
          postId
        );
      }

      await loadFeed();
      toast("Comment added.");
    } catch (error) {
      toast(error.message || "Unable to add comment.");
    } finally {
      if (button) button.disabled = false;
    }
  }

  async function editPost(postId) {
    const post = state.posts.find(item => item.id === postId);
    if (!post || post.user_id !== state.user.id) return;

    const content = prompt("Edit your post:", post.content || "");
    if (content === null) return;

    const cleaned = content.trim();

    if (!cleaned && !post.image_url) {
      toast("A post must contain text or an image.");
      return;
    }

    try {
      const { error } = await db
        .from("posts")
        .update({
          content: cleaned,
          updated_at: new Date().toISOString()
        })
        .eq("id", postId)
        .eq("user_id", state.user.id);

      if (error) throw error;

      toast("Post updated.");
      await Promise.all([loadFeed(), loadMyPosts()]);
    } catch (error) {
      toast(error.message || "Unable to edit post.");
    }
  }

  async function deletePost(postId) {
    if (!confirm("Delete this post permanently?")) return;

    try {
      const { error } = await db
        .from("posts")
        .delete()
        .eq("id", postId)
        .eq("user_id", state.user.id);

      if (error) throw error;

      toast("Post deleted.");
      await Promise.all([loadFeed(), loadMyPosts()]);
    } catch (error) {
      toast(error.message || "Unable to delete post.");
    }
  }

  async function loadMyPosts() {
    if (!state.user) return;

    const container = $("#my-posts");
    if (!container) return;

    try {
      const { data: posts, error } = await db
        .from("posts")
        .select("*")
        .eq("user_id", state.user.id)
        .order("created_at", { ascending: false })
        .limit(50);

      if (error) throw error;

      if (!posts?.length) {
        container.innerHTML = `
          <div class="empty-state">
            <h3>No posts yet</h3>
            <p>Your posts will appear here.</p>
          </div>`;
        return;
      }

      const ids = posts.map(post => post.id);

      const [likesResult, commentsResult] = await Promise.all([
        db.from("likes").select("post_id,user_id").in("post_id", ids),
        db.from("comments")
          .select("id,post_id,user_id,content,created_at")
          .in("post_id", ids)
          .order("created_at", { ascending: true })
      ]);

      if (likesResult.error) throw likesResult.error;
      if (commentsResult.error) throw commentsResult.error;

      const likeCounts = {};
      for (const like of likesResult.data || []) {
        likeCounts[like.post_id] = (likeCounts[like.post_id] || 0) + 1;
      }

      const grouped = {};
      for (const comment of commentsResult.data || []) {
        (grouped[comment.post_id] ||= []).push(comment);
      }

      const likedIds = new Set(
        (likesResult.data || [])
          .filter(like => like.user_id === state.user.id)
          .map(like => like.post_id)
      );

      const profileMap = new Map([[state.user.id, state.profile]]);

      container.innerHTML = posts.map(post => renderPost(
        post,
        state.profile,
        {
          likeCount: likeCounts[post.id] || 0,
          liked: likedIds.has(post.id),
          comments: grouped[post.id] || [],
          profileMap,
          mine: true
        }
      )).join("");
    } catch (error) {
      console.error("My posts:", error);
      container.innerHTML =
        `<div class="empty-state">${escapeHTML(error.message)}</div>`;
    }
  }

  // =========================================================
  // PROFILE EDITING AND AVATAR UPLOAD
  // =========================================================

  function toggleProfileEditor(show) {
    $("#profile-form")?.classList.toggle("hidden", !show);

    if (show) {
      $("#edit-display-name").value = state.profile?.display_name || "";
      $("#edit-username").value = state.profile?.username || "";
      $("#edit-bio").value = state.profile?.bio || "";
    }
  }

  async function saveProfile(event) {
    event.preventDefault();
    if (!state.user) return;

    const display_name = $("#edit-display-name").value.trim();
    const username = normalizeUsername($("#edit-username").value);
    const bio = $("#edit-bio").value.trim();

    if (!display_name || display_name.length > 60) {
      toast("Display name must be 1–60 characters.");
      return;
    }

    if (!validateUsername(username)) {
      toast("Username must be 3–24 letters, numbers, or underscores.");
      return;
    }

    const form = event.currentTarget;
    setBusy(form, true);

    try {
      const { data: existing, error: lookupError } = await db
        .from("profiles")
        .select("id")
        .eq("username", username)
        .neq("id", state.user.id)
        .maybeSingle();

      if (lookupError) throw lookupError;
      if (existing) throw new Error("That username is already taken.");

      const { data, error } = await db
        .from("profiles")
        .update({ display_name, username, bio })
        .eq("id", state.user.id)
        .select("*")
        .single();

      if (error) throw error;

      state.profile = data;
      updateMyProfileUI();
      toggleProfileEditor(false);
      toast("Profile saved.");
      await loadPeople($("#user-search")?.value || "");
    } catch (error) {
      toast(error.message || "Unable to save profile.");
    } finally {
      setBusy(form, false);
    }
  }

  async function changeAvatar(event) {
    const file = event.target.files?.[0];
    if (!file || !state.user) return;

    try {
      const uploaded = await uploadFile(
        "avatars",
        file,
        state.user.id,
        5 * 1024 * 1024
      );

      const { data, error } = await db
        .from("profiles")
        .update({ avatar_url: uploaded.url })
        .eq("id", state.user.id)
        .select("*")
        .single();

      if (error) throw error;

      state.profile = data;
      updateMyProfileUI();
      toast("Profile picture updated.");
    } catch (error) {
      toast(error.message || "Unable to upload profile picture.");
    } finally {
      event.target.value = "";
    }
  }

  // =========================================================
  // NOTIFICATIONS
  // =========================================================

  async function createNotification(userId, type, message, postId = null) {
    if (!state.user || !userId || userId === state.user.id) return;

    const { error } = await db.from("notifications").insert({
      user_id: userId,
      actor_id: state.user.id,
      type,
      message,
      post_id: postId
    });

    if (error) console.warn("Notification:", error.message);
  }

  async function loadNotifications() {
    if (!state.user) return;

    const container = $("#notifications");
    if (!container) return;

    try {
      const { data, error } = await db
        .from("notifications")
        .select("*")
        .eq("user_id", state.user.id)
        .order("created_at", { ascending: false })
        .limit(50);

      if (error) throw error;

      if (!data?.length) {
        container.innerHTML = `
          <div class="empty-state">
            <h3>You're all caught up</h3>
            <p>New activity will show up here.</p>
          </div>`;
        return;
      }

      container.innerHTML = data.map(notification => `
        <article class="notification-item ${notification.is_read ? "" : "unread"}">
          <div class="notification-content">
            <p>${escapeHTML(notification.message || notification.type || "Notification")}</p>
            <small>${escapeHTML(timeAgo(notification.created_at))}</small>
          </div>
          ${notification.post_id ? `
            <button class="btn btn-secondary" type="button"
              data-action="open-post"
              data-post-id="${escapeHTML(notification.post_id)}">
              View post
            </button>` : ""}
          ${!notification.is_read ? `
            <button class="btn btn-ghost" type="button"
              data-action="read-notification"
              data-notification-id="${escapeHTML(notification.id)}">
              Mark read
            </button>` : ""}
        </article>
      `).join("");
    } catch (error) {
      console.error("Notifications:", error);
      container.innerHTML = `
        <div class="empty-state">
          <h3>Unable to load notifications</h3>
          <p>${escapeHTML(error.message)}</p>
        </div>`;
    }
  }

  async function markNotificationRead(id) {
    try {
      const { error } = await db
        .from("notifications")
        .update({ is_read: true })
        .eq("id", id)
        .eq("user_id", state.user.id);

      if (error) throw error;

      await loadNotifications();
    } catch (error) {
      toast(error.message || "Unable to mark notification as read.");
    }
  }

  // =========================================================
  // DIRECT MESSAGES
  // =========================================================

  async function openConversation(personId) {
    if (!state.user || personId === state.user.id) return;

    try {
      const { data: person, error } = await db
        .from("profiles")
        .select("*")
        .eq("id", personId)
        .single();

      if (error) throw error;

      state.activePerson = person;

      setImage($("#chat-avatar"), avatarURL(person), displayName(person));

      if ($("#chat-title")) {
        $("#chat-title").textContent = displayName(person);
      }

      if ($("#chat-subtitle")) {
        $("#chat-subtitle").textContent =
          isOnline(person) ? "Online" : "Offline";
      }

      $("#message-input").disabled = false;
      $("#send-button").disabled = false;

      switchView("messages");
      await loadMessages();

      if (state.messageChannel) {
        await db.removeChannel(state.messageChannel);
      }

      state.messageChannel = db.channel(
        `talkatch-messages-${state.user.id}-${personId}`
      ).on("postgres_changes", {
        event: "*",
        schema: "public",
        table: "messages"
      }, payload => {
        const row = payload.new || payload.old;

        if (
          row &&
          (
            (row.sender_id === state.user.id &&
              row.receiver_id === personId) ||
            (row.sender_id === personId &&
              row.receiver_id === state.user.id)
          )
        ) {
          loadMessages();
          loadConversationList();
        }
      }).subscribe();

    } catch (error) {
      toast(error.message || "Unable to open conversation.");
    }
  }

  async function loadConversationList() {
    if (!state.user) return;

    const container = $("#conversation-list");
    if (!container) return;

    try {
      // This is intentionally based on the profiles table, not on a
      // recursive conversation_members policy.
      const { data, error } = await db
        .from("profiles")
        .select("id,username,display_name,avatar_url,last_seen_at")
        .neq("id", state.user.id)
        .order("display_name", { ascending: true })
        .limit(100);

      if (error) throw error;

      if (!data?.length) {
        container.innerHTML =
          '<div class="empty-state">No other members yet.</div>';
        return;
      }

      container.innerHTML = data.map(person => `
        <button class="person conversation-person" type="button"
          data-action="message" data-user-id="${escapeHTML(person.id)}">
          <img class="avatar" src="${escapeHTML(avatarURL(person))}"
            alt="">
          <span class="user-details">
            <strong class="user-name">${escapeHTML(displayName(person))}</strong>
            <span class="user-handle">@${escapeHTML(person.username)}</span>
            <span class="presence-label">
              ${isOnline(person) ? "Online" : "Offline"}
            </span>
          </span>
        </button>
      `).join("");
    } catch (error) {
      console.error("Conversation list:", error);
      container.innerHTML = `
        <div class="empty-state">
          <p>${escapeHTML(error.message)}</p>
        </div>`;
    }
  }

  async function loadMessages() {
    if (!state.user || !state.activePerson || state.loadingMessages) return;

    state.loadingMessages = true;
    const container = $("#messages");

    try {
      const otherId = state.activePerson.id;

      const { data, error } = await db
        .from("messages")
        .select("*")
        .or(
          `and(sender_id.eq.${state.user.id},receiver_id.eq.${otherId}),` +
          `and(sender_id.eq.${otherId},receiver_id.eq.${state.user.id})`
        )
        .order("created_at", { ascending: true })
        .limit(200);

      if (error) throw error;

      if (!data?.length) {
        container.innerHTML = `
          <div class="empty-state">
            <h3>Start the conversation</h3>
            <p>Send your first message below.</p>
          </div>`;
        return;
      }

      container.innerHTML = data.map(message => {
        const mine = message.sender_id === state.user.id;

        let attachment = "";

        if (message.attachment_path) {
          const fileName = escapeHTML(
            message.attachment_name || "Attachment"
          );

          if (message.attachment_type?.startsWith("image/")) {
            const { data: signedData } = db.storage
              .from("message-files")
              .getPublicUrl(message.attachment_path);

            attachment = `
              <p class="message-attachment">${fileName}</p>
              <p class="attachment-note">
                Image attachment requires a private signed URL to display.
              </p>`;
          } else {
            attachment = `<p class="message-attachment">${fileName}</p>`;
          }
        }

        return `
          <article class="message ${mine ? "message-own" : "message-other"}">
            ${message.content
              ? `<p>${escapeHTML(message.content).replace(/\n/g, "<br>")}</p>`
              : ""}
            ${attachment}
            <small>${escapeHTML(timeAgo(message.created_at))}</small>
          </article>`;
      }).join("");

      container.scrollTop = container.scrollHeight;
    } catch (error) {
      console.error("Messages:", error);
      container.innerHTML = `
        <div class="empty-state">
          <p>Unable to load messages: ${escapeHTML(error.message)}</p>
        </div>`;
    } finally {
      state.loadingMessages = false;
    }
  }

  async function sendMessage(event) {
    event.preventDefault();

    if (!state.user || !state.activePerson) {
      toast("Choose a person to message first.");
      return;
    }

    const content = $("#message-input").value.trim();
    const file = $("#file-input")?.files?.[0];

    if (!content && !file) return;

    const button = $("#send-button");
    button.disabled = true;

    try {
      let attachment = null;

      if (file) {
        attachment = await uploadFile(
          "message-files",
          file,
          state.user.id,
          CONFIG.maxFileBytes || 15 * 1024 * 1024
        );
      }

      const { error } = await db.from("messages").insert({
        sender_id: state.user.id,
        receiver_id: state.activePerson.id,
        content,
        attachment_path: attachment?.path || null,
        attachment_name: attachment?.name || null,
        attachment_type: attachment?.type || null,
        attachment_size: attachment?.size || null
      });

      if (error) throw error;

      $("#message-input").value = "";
      $("#file-input").value = "";

      await loadMessages();
      await loadConversationList();
    } catch (error) {
      toast(error.message || "Unable to send message.");
    } finally {
      button.disabled = false;
    }
  }

  // =========================================================
  // REALTIME
  // =========================================================

  function setupRealtime() {
    if (!state.user) return;

    if (state.realtimeFeed) {
      db.removeChannel(state.realtimeFeed);
    }

    if (state.realtimeNotifications) {
      db.removeChannel(state.realtimeNotifications);
    }

    state.realtimeFeed = db.channel("talkatch-feed-updates")
      .on("postgres_changes", {
        event: "*",
        schema: "public",
        table: "posts"
      }, () => {
        if (state.activeView === "feed") loadFeed();
        if (state.activeView === "profile") loadMyPosts();
      })
      .subscribe();

    state.realtimeNotifications = db.channel(
      `talkatch-notifications-${state.user.id}`
    ).on("postgres_changes", {
      event: "INSERT",
      schema: "public",
      table: "notifications",
      filter: `user_id=eq.${state.user.id}`
    }, () => {
      if (state.activeView === "notifications") loadNotifications();
      toast("You have a new notification.");
    }).subscribe();
  }

  // =========================================================
  // EVENT DELEGATION
  // =========================================================

  document.addEventListener("click", async event => {
    const tab = event.target.closest("[data-tab]");
    if (tab) {
      switchAuthTab(tab.dataset.tab);
      return;
    }

    const nav = event.target.closest("[data-view]");
    if (nav) {
      switchView(nav.dataset.view);
      return;
    }

    const profileTab = event.target.closest("[data-profile-tab]");
    if (profileTab) {
      if (profileTab.dataset.profileTab === "about") {
        toggleProfileEditor(true);
      } else {
        toggleProfileEditor(false);
        loadMyPosts();
      }

      $$(".profile-tab").forEach(button => {
        button.classList.toggle("active", button === profileTab);
      });
      return;
    }

    const actionButton = event.target.closest("[data-action]");
    if (!actionButton) return;

    const action = actionButton.dataset.action;
    const userId = actionButton.dataset.userId;
    const postId = actionButton.dataset.postId;

    switch (action) {
      case "follow":
        await toggleFollow(userId, actionButton);
        break;

      case "message":
        await openConversation(userId);
        break;

      case "like":
        await toggleLike(postId, actionButton);
        break;

      case "focus-comment": {
        const card = actionButton.closest("[data-post-id]");
        const input = $('input[name="content"]', card);
        input?.focus();
        break;
      }

      case "edit-post":
        await editPost(postId);
        break;

      case "delete-post":
        await deletePost(postId);
        break;

      case "read-notification":
        await markNotificationRead(actionButton.dataset.notificationId);
        break;

      case "open-post":
        switchView("feed");
        setTimeout(() => {
          const target = $(`[data-post-id="${CSS.escape(postId)}"]`, $("#feed-list"));
          target?.scrollIntoView({ behavior: "smooth", block: "center" });
        }, 400);
        break;
    }
  });

  document.addEventListener("submit", async event => {
    if (event.target.matches("#login-form")) {
      await login(event);
    } else if (event.target.matches("#signup-form")) {
      await signup(event);
    } else if (event.target.matches("#post-form")) {
      await publishPost(event);
    } else if (event.target.matches("#profile-form")) {
      await saveProfile(event);
    } else if (event.target.matches("#message-form")) {
      await sendMessage(event);
    } else if (event.target.matches(".comment-form")) {
      await addComment(event);
    }
  });

  $("#forgot-password")?.addEventListener("click", forgotPassword);
  $("#logout-button")?.addEventListener("click", logout);

  $("#theme-button")?.addEventListener("click", () => {
    setTheme(state.theme === "dark" ? "light" : "dark");
  });

  $("#refresh-users")?.addEventListener("click", async () => {
    await Promise.allSettled([
      loadPeople($("#user-search")?.value || ""),
      loadFeed(),
      loadConversationList(),
      loadNotifications()
    ]);

    toast("Content refreshed.");
  });

  $("#user-search")?.addEventListener("input", event => {
    clearTimeout(state.searchTimer);

    state.searchTimer = setTimeout(() => {
      loadPeople(event.target.value);
    }, 250);
  });

  $("#edit-profile-button")?.addEventListener("click", () => {
    toggleProfileEditor(true);
  });

  $("#cancel-profile-edit")?.addEventListener("click", () => {
    toggleProfileEditor(false);
  });

  $("#my-avatar")?.addEventListener("click", () => {
    $("#avatar-upload")?.click();
  });

  $("#my-avatar")?.addEventListener("keydown", event => {
    if (event.key === "Enter" || event.key === " ") {
      event.preventDefault();
      $("#avatar-upload")?.click();
    }
  });

  $("#avatar-upload")?.addEventListener("change", changeAvatar);

  $("#post-image")?.addEventListener("change", event => {
    const file = event.target.files?.[0];
    const preview = $("#post-image-preview");

    if (!preview) return;

    preview.replaceChildren();

    if (!file) {
      preview.classList.add("hidden");
      return;
    }

    if (!file.type.startsWith("image/")) {
      toast("Please choose an image.");
      event.target.value = "";
      preview.classList.add("hidden");
      return;
    }

    if (file.size > 8 * 1024 * 1024) {
      toast("Post images must be 8 MB or smaller.");
      event.target.value = "";
      preview.classList.add("hidden");
      return;
    }

    const image = document.createElement("img");
    image.alt = "Post image preview";
    image.className = "post-image";
    image.src = URL.createObjectURL(file);

    preview.appendChild(image);
    preview.classList.remove("hidden");
  });

  // =========================================================
  // AUTH STATE AND INITIALIZATION
  // =========================================================

  async function initialize() {
    setTheme(state.theme);

    try {
      const { data, error } = await db.auth.getSession();
      if (error) throw error;

      if (data.session?.user) {
        await enterApp(data.session.user);
      } else {
        showAuth(true);
        switchAuthTab("login");
      }
    } catch (error) {
      console.error("Initialization:", error);
      showAuth(true);
      setAuthMessage(
        "Unable to initialize TALKATCH. Check your Supabase configuration.",
        true
      );
    }

    db.auth.onAuthStateChange((event, session) => {
      // Defer async work to avoid blocking the auth callback.
      setTimeout(async () => {
        if (event === "PASSWORD_RECOVERY") {
          const newPassword = prompt("Enter your new password (at least 8 characters):");

          if (newPassword === null) return;

          if (newPassword.length < 8) {
            toast("Password must be at least 8 characters.");
            return;
          }

          const { error } = await db.auth.updateUser({
            password: newPassword
          });

          if (error) {
            toast(error.message);
          } else {
            toast("Password updated successfully.");
          }

          return;
        }

        if (session?.user && !state.user) {
          await enterApp(session.user);
        } else if (!session?.user && state.user) {
          state.user = null;
          state.profile = null;
          showAuth(true);
        }
      }, 0);
    });
  }

  initialize();
})();
