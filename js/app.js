
(() => {
  "use strict";

  const config = window.TALKATCH_CONFIG || {};
  const validConfig =
    /^https:\/\/.+\.supabase\.co$/.test(config.supabaseUrl || "") &&
    !!config.supabasePublishableKey &&
    !String(config.supabasePublishableKey).includes("YOUR_SUPABASE");

  const db = validConfig
    ? window.supabase.createClient(
        config.supabaseUrl,
        config.supabasePublishableKey
      )
    : null;

  const $ = (id) => document.getElementById(id);
  let mode = "login";
  let user = null;
  let profile = null;
  let posts = [];
  let people = [];
  let activeTab = "feed";

  function escapeHTML(value = "") {
    return String(value).replace(/[&<>"']/g, (char) => ({
      "&": "&amp;", "<": "&lt;", ">": "&gt;",
      '"': "&quot;", "'": "&#39;"
    }[char]));
  }

  function initials(name = "TALKATCH") {
    return name.trim().split(/\s+/).slice(0, 2)
      .map((word) => word[0] || "").join("").toUpperCase() || "T";
  }

  function avatarMarkup(person, small = false) {
    const name = person?.display_name || person?.username || "User";
    const url = person?.avatar_url;
    const size = small ? " small" : "";
    if (url && /^https:\/\//i.test(url)) {
      return `<img class="avatar${size}" src="${escapeHTML(url)}" alt=""
        referrerpolicy="no-referrer"
        onerror="this.replaceWith(Object.assign(document.createElement('span'),{className:'avatar${size}',textContent:'${escapeHTML(initials(name))}'}))">`;
    }
    return `<span class="avatar${size}">${escapeHTML(initials(name))}</span>`;
  }

  function message(id, text, isError = false) {
    const element = $(id);
    if (!element) return;
    element.textContent = text;
    element.classList.toggle("error", isError);
  }

  function showAuth() {
    $("authPage").classList.remove("hidden");
    $("dashboard").classList.add("hidden");
  }

  function showDashboard() {
    $("authPage").classList.add("hidden");
    $("dashboard").classList.remove("hidden");
  }

  function updateAuthMode() {
    const signup = mode === "signup";
    $("authHeading").textContent = signup ? "Create your space." : "Welcome back.";
    $("authDescription").textContent = signup
      ? "Join TALKATCH and connect with your community."
      : "Sign in to continue the conversation.";
    $("submitAuth").textContent = signup ? "Create account" : "Sign in";
    $("switchLabel").textContent = signup ? "Already have an account?" : "New to TALKATCH?";
    $("switchMode").textContent = signup ? "Sign in" : "Create account";
    $("displayNameGroup").classList.toggle("hidden", !signup);
    $("password").autocomplete = signup ? "new-password" : "current-password";
    message("authMessage", "");
  }

  async function handleAuth(event) {
    event.preventDefault();
    if (!db) {
      message("authMessage", "Configuration missing. Check config.js and your Supabase URL/key.", true);
      return;
    }

    const email = $("email").value.trim();
    const password = $("password").value;
    const displayName = $("displayName").value.trim() || email.split("@")[0];
    const button = $("submitAuth");
    button.disabled = true;
    message("authMessage", mode === "signup" ? "Creating your account..." : "Signing in...");

    try {
      let result;

      if (mode === "signup") {
        const username = email.split("@")[0]
          .toLowerCase().replace(/[^a-z0-9_]/g, "").slice(0, 20) || "user";

        result = await db.auth.signUp({
          email,
          password,
          options: {
            data: { username, display_name: displayName },
            emailRedirectTo: window.location.origin
          }
        });
      } else {
        result = await db.auth.signInWithPassword({ email, password });
      }

      if (result.error) throw result.error;

      if (mode === "signup" && !result.data.session) {
        message("authMessage", "Account created. Check your email to confirm, then sign in.");
      } else if (result.data.session?.user) {
        user = result.data.session.user;
        await openDashboard();
      } else {
        message("authMessage", "Check your email or try signing in again.");
      }
    } catch (error) {
      message("authMessage", error.message || "Authentication failed.", true);
    } finally {
      button.disabled = false;
    }
  }

  async function googleLogin() {
    if (!db) {
      message("authMessage", "Add your Supabase URL and publishable key to config.js first.", true);
      return;
    }
    const button = $("googleButton");
    button.disabled = true;
    message("authMessage", "Redirecting to Google...");

    const { error } = await db.auth.signInWithOAuth({
      provider: "google",
      options: { redirectTo: window.location.origin }
    });

    if (error) {
      message("authMessage", error.message, true);
      button.disabled = false;
    }
  }

  async function fetchProfile() {
    const { data, error } = await db.from("profiles")
      .select("id,username,display_name,bio,avatar_url,created_at")
      .eq("id", user.id).maybeSingle();

    if (error) throw error;

    if (!data) {
      // If your signup trigger failed, do not silently create an unsafe
      // or duplicate profile. Fix the trigger in Supabase SQL Editor.
      throw new Error("Your account exists, but its profile is missing. Check the on_auth_user_created trigger in Supabase.");
    }
    profile = data;
  }

  function paintProfile() {
    const name = profile?.display_name || user?.email || "TALKATCH user";
    $("sidebarUser").innerHTML =
      `${avatarMarkup(profile, true)}<br><strong>${escapeHTML(name)}</strong><br><span class="muted">@${escapeHTML(profile?.username || "user")}</span>`;
    $("topUser").innerHTML = avatarMarkup(profile);
    $("profileName").value = profile?.display_name || "";
    $("profileBio").value = profile?.bio || "";
    $("profileAvatar").value = profile?.avatar_url || "";
  }

  async function openDashboard() {
    showDashboard();
    try {
      await fetchProfile();
      paintProfile();
      await loadFeed();
      await loadPeople("");
    } catch (error) {
      console.error(error);
      alert("TALKATCH could not load your profile: " + error.message);
    }
  }

  function goTab(tab) {
    activeTab = tab;
    const names = {
      feed: "Home feed",
      people: "Discover people",
      profile: "My profile"
    };
    $("viewTitle").textContent = names[tab];

    document.querySelectorAll(".tab-content").forEach((section) => {
      section.classList.add("hidden");
    });
    $(tab + "Tab").classList.remove("hidden");

    document.querySelectorAll("[data-tab]").forEach((button) => {
      button.classList.toggle("selected", button.dataset.tab === tab);
    });

    if (tab === "feed") loadFeed();
    if (tab === "people") loadPeople($("peopleQuery").value);
  }

  function timeLabel(date) {
    const seconds = Math.max(0, (Date.now() - new Date(date).getTime()) / 1000);
    if (seconds < 60) return "Just now";
    if (seconds < 3600) return Math.floor(seconds / 60) + "m ago";
    if (seconds < 86400) return Math.floor(seconds / 3600) + "h ago";
    return new Date(date).toLocaleDateString();
  }

  async function loadFeed() {
    $("feedList").innerHTML = '<div class="panel muted">Loading posts...</div>';
    const { data, error } = await db.from("posts")
      .select("id,user_id,content,image_url,created_at")
      .order("created_at", { ascending: false }).limit(50);

    if (error) {
      $("feedList").textContent = error.message;
      return;
    }

    const feed = data || [];
    if (!feed.length) {
      posts = [];
      $("feedList").innerHTML = '<div class="panel"><h2>No posts yet</h2><p class="muted">Be the first to share a thought.</p></div>';
      return;
    }

    const ids = [...new Set(feed.map((post) => post.user_id))];
    const postIds = feed.map((post) => post.id);

    const [profileResult, likeResult] = await Promise.all([
      db.from("profiles").select("id,username,display_name,avatar_url").in("id", ids),
      db.from("likes").select("post_id,user_id").in("post_id", postIds)
    ]);

    if (profileResult.error) {
      $("feedList").textContent = profileResult.error.message;
      return;
    }
    if (likeResult.error) {
      $("feedList").textContent = likeResult.error.message;
      return;
    }

    const profiles = Object.fromEntries((profileResult.data || []).map((p) => [p.id, p]));
    const likes = likeResult.data || [];
    posts = feed.map((post) => ({
      ...post,
      profile: profiles[post.user_id],
      likes: likes.filter((like) => like.post_id === post.id)
    }));

    $("feedList").innerHTML = posts.map((post) => {
      const liked = post.likes.some((like) => like.user_id === user.id);
      const author = post.profile || { display_name: "TALKATCH user", username: "user" };
      const image = post.image_url && /^https:\/\//i.test(post.image_url)
        ? `<img class="post-image" src="${escapeHTML(post.image_url)}" alt="Post image" style="width:100%;border-radius:12px;margin-top:10px">`
        : "";

      return `
        <article class="panel" data-post-id="${post.id}">
          <div class="post-head">
            ${avatarMarkup(author, true)}
            <div class="post-author">
              <strong>${escapeHTML(author.display_name || author.username)}</strong>
              <span>@${escapeHTML(author.username || "user")} · ${timeLabel(post.created_at)}</span>
            </div>
            ${post.user_id === user.id ? `<button class="action-button" data-delete="${post.id}" aria-label="Delete post">Delete</button>` : ""}
          </div>
          <div class="post-text">${escapeHTML(post.content)}</div>
          ${image}
          <div class="post-actions">
            <button class="action-button" data-like="${post.id}">${liked ? "♥ Liked" : "♡ Like"} · ${post.likes.length}</button>
          </div>
        </article>`;
    }).join("");
  }

  async function publishPost(event) {
    event.preventDefault();
    const content = $("postContent").value.trim();
    if (!content) return;

    const button = event.submitter;
    button.disabled = true;
    message("postMessage", "Publishing...");

    const { error } = await db.from("posts").insert({
      user_id: user.id,
      content
    });

    button.disabled = false;
    if (error) {
      message("postMessage", error.message, true);
      return;
    }

    $("postContent").value = "";
    message("postMessage", "Published!");
    await loadFeed();
  }

  async function feedClick(event) {
    const likeButton = event.target.closest("[data-like]");
    const deleteButton = event.target.closest("[data-delete]");

    if (likeButton) {
      const post = posts.find((item) => item.id === likeButton.dataset.like);
      if (!post) return;
      likeButton.disabled = true;

      const alreadyLiked = post.likes.some((like) => like.user_id === user.id);
      const result = alreadyLiked
        ? await db.from("likes").delete().eq("post_id", post.id).eq("user_id", user.id)
        : await db.from("likes").insert({ post_id: post.id, user_id: user.id });

      if (result.error) alert(result.error.message);
      await loadFeed();
    }

    if (deleteButton) {
      if (!confirm("Delete this post?")) return;
      const { error } = await db.from("posts")
        .delete().eq("id", deleteButton.dataset.delete).eq("user_id", user.id);
      if (error) alert(error.message);
      else await loadFeed();
    }
  }

  async function saveProfile(event) {
    event.preventDefault();
    const display_name = $("profileName").value.trim();
    const bio = $("profileBio").value.trim();
    const avatar_url = $("profileAvatar").value.trim() || null;

    if (avatar_url && !/^https:\/\//i.test(avatar_url)) {
      message("profileMessage", "Avatar URL must start with https://", true);
      return;
    }

    message("profileMessage", "Saving...");
    const { error } = await db.from("profiles")
      .update({ display_name, bio, avatar_url })
      .eq("id", user.id);

    if (error) {
      message("profileMessage", error.message, true);
      return;
    }

    await fetchProfile();
    paintProfile();
    message("profileMessage", "Profile saved.");
  }

  async function loadPeople(query) {
    const { data, error } = await db.from("profiles")
      .select("id,username,display_name,bio,avatar_url")
      .neq("id", user.id).order("created_at", { ascending: false }).limit(100);

    if (error) {
      $("peopleList").textContent = error.message;
      return;
    }

    people = data || [];
    const term = (query || "").trim().toLowerCase();
    const filtered = people.filter((person) =>
      !term ||
      (person.display_name || "").toLowerCase().includes(term) ||
      (person.username || "").toLowerCase().includes(term)
    );

    $("peopleList").innerHTML = filtered.length ? filtered.map((person) => `
      <article class="person-card">
        ${avatarMarkup(person)}
        <strong>${escapeHTML(person.display_name || person.username)}</strong>
        <div class="muted">@${escapeHTML(person.username || "user")}</div>
        <p>${escapeHTML(person.bio || "A member of TALKATCH.")}</p>
      </article>
    `).join("") : '<div class="panel">No users found.</div>';
  }

  async function logout() {
    const { error } = await db.auth.signOut();
    if (error) {
      alert(error.message);
      return;
    }
    user = null;
    profile = null;
    showAuth();
  }

  async function boot() {
    if (!db) {
      showAuth();
      message("authMessage", "Setup needed: check your Supabase URL and publishable key in config.js.", true);
      return;
    }

    $("authForm").addEventListener("submit", handleAuth);
    $("googleButton").addEventListener("click", googleLogin);
    $("switchMode").addEventListener("click", () => {
      mode = mode === "login" ? "signup" : "login";
      updateAuthMode();
    });
    $("logoutButton").addEventListener("click", logout);
    $("postForm").addEventListener("submit", publishPost);
    $("feedList").addEventListener("click", feedClick);
    $("profileForm").addEventListener("submit", saveProfile);
    $("peopleQuery").addEventListener("input", (event) => {
      clearTimeout(window.talkatchSearchTimer);
      window.talkatchSearchTimer = setTimeout(() => loadPeople(event.target.value), 250);
    });

    document.querySelectorAll("[data-tab]").forEach((button) => {
      button.addEventListener("click", () => goTab(button.dataset.tab));
    });

    const { data, error } = await db.auth.getSession();
    if (error) {
      message("authMessage", error.message, true);
      return;
    }

    if (data.session?.user) {
      user = data.session.user;
      await openDashboard();
    } else {
      showAuth();
    }

    db.auth.onAuthStateChange((_event, session) => {
      if (session?.user && (!user || user.id !== session.user.id)) {
        user = session.user;
        setTimeout(() => openDashboard(), 0);
      } else if (!session) {
        user = null;
        profile = null;
        showAuth();
      }
    });
  }

  updateAuthMode();
  boot();
})();
