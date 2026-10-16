(() => {
  "use strict";

  const config = window.TALKATCH_CONFIG || {};
  const $ = (selector, root = document) => root.querySelector(selector);
  const $$ = (selector, root = document) => [...root.querySelectorAll(selector)];

  let db;
  let user = null;
  let profile = null;
  let profiles = [];
  let selectedChat = null;
  let chatChannel = null;
  let feedChannel = null;
  let pendingPostFile = null;
  let pendingAvatarFile = null;
  let toastTimer;

  const BUCKET_AVATARS = "avatars";
  const BUCKET_POSTS = "post-images";
  const BUCKET_FILES = "chat-files";
  const MAX_IMAGE_SIZE = 5 * 1024 * 1024;
  const MAX_FILE_SIZE = 15 * 1024 * 1024;

  function toast(message) {
    const element = $("#toast");
    if (!element) return;

    element.textContent = message;
    element.classList.add("show");

    clearTimeout(toastTimer);
    toastTimer = setTimeout(() => element.classList.remove("show"), 3500);
  }

  function esc(value = "") {
    return String(value).replace(/[&<>"']/g, character => ({
      "&": "&amp;",
      "<": "&lt;",
      ">": "&gt;",
      '"': "&quot;",
      "'": "&#39;"
    })[character]);
  }

  function icon(name) {
    return `<i data-lucide="${esc(name)}"></i>`;
  }

  function icons() {
    try {
      window.lucide?.createIcons();
    } catch (error) {
      console.warn("Icon rendering failed", error);
    }
  }

  function avatar(person) {
    if (person?.avatar_url) return person.avatar_url;

    const name = encodeURIComponent(
      person?.display_name || person?.username || "User"
    );

    return `https://ui-avatars.com/api/?name=${name}&background=6558e8&color=fff`;
  }

  function setMessage(message) {
    $("#auth-message").textContent = message || "";
  }

  function showAuth() {
    $("#auth-screen").hidden = false;
    $("#app-screen").hidden = true;
  }

  function showApp() {
    $("#auth-screen").hidden = true;
    $("#app-screen").hidden = false;
    icons();
  }

  function setAuthMode(mode) {
    const login = mode === "login";

    $("#loginForm").hidden = !login;
    $("#signupForm").hidden = login;

    $("#login-tab").classList.toggle("active", login);
    $("#signup-tab").classList.toggle("active", !login);

    $("#auth-heading").textContent = login
      ? "Welcome back"
      : "Join the community";

    setMessage("");
    icons();
  }

  function switchView(name) {
    $$(".view").forEach(view => {
      view.hidden = view.id !== `view-${name}`;
    });

    $$(".nav-item[data-view]").forEach(button => {
      button.classList.toggle("active", button.dataset.view === name);
    });

    if (name === "home") loadFeed();
    if (name === "explore") renderExplore();
    if (name === "notifications") loadNotifications();
    if (name === "profile") renderProfilePage(user.id);
    if (name === "messages") renderMessagePeople();

    icons();
  }

  async function getProfile(id) {
    const { data, error } = await db
      .from("profiles")
      .select("*")
      .eq("id", id)
      .maybeSingle();

    if (error) throw error;

    if (data) return data;

    const metadata = user.user_metadata || {};

    const row = {
      id,
      username: metadata.username || `user_${id.slice(0, 8)}`,
      display_name: metadata.display_name || "New user",
      bio: "",
      avatar_url: null
    };

    const { data: created, error: insertError } = await db
      .from("profiles")
      .insert(row)
      .select()
      .single();

    if (insertError) throw insertError;

    return created;
  }

  async function loadProfile() {
    profile = await getProfile(user.id);

    $("#sidebar-avatar").src = avatar(profile);
    $("#sidebar-name").textContent = profile.display_name || profile.username;
    $("#sidebar-username").textContent = `@${profile.username}`;
    $("#composer-avatar").src = avatar(profile);

    $("#profile-avatar-preview").src = avatar(profile);
    $("#edit-display-name").value = profile.display_name || "";
    $("#edit-username").value = profile.username || "";
    $("#edit-bio").value = profile.bio || "";
  }

  async function enterApp(sessionUser) {
    user = sessionUser;
    showApp();

    try {
      await loadProfile();
    } catch (error) {
      console.error("Profile loading failed:", error);
      toast("Profile error. Check the profiles table and RLS policies.");
    }

    await Promise.allSettled([
      loadPeople(),
      loadFeed(),
      loadNotifications()
    ]);

    startFeedRealtime();
    icons();
  }

  async function loadPeople() {
    const { data, error } = await db
      .from("profiles")
      .select("id,username,display_name,bio,avatar_url,created_at")
      .neq("id", user.id)
      .order("created_at", { ascending: false })
      .limit(150);

    if (error) {
      console.error("People loading failed:", error);
      toast("Unable to load suggested users.");
      return;
    }

    profiles = data || [];

    renderSuggestions();
    renderExplore();
    renderMessagePeople();
  }

  function renderSuggestions() {
    const root = $("#suggested-users");
    root.replaceChildren();

    const suggestions = profiles
      .filter(person => person.id !== user.id)
      .slice(0, 6);

    if (!suggestions.length) {
      root.innerHTML = '<p class="muted small">Invite others to join TALKATCH.</p>';
      return;
    }

    suggestions.forEach(person => {
      const row = document.createElement("div");
      row.className = "suggested-user";

      const image = document.createElement("img");
      image.src = avatar(person);
      image.alt = "";

      const info = document.createElement("div");
      info.className = "suggested-info";

      const name = document.createElement("strong");
      name.textContent = person.display_name || person.username;

      const username = document.createElement("small");
      username.textContent = `@${person.username}`;

      info.append(name, username);

      const follow = document.createElement("button");
      follow.className = "follow-small";
      follow.type = "button";
      follow.title = "Follow user";
      follow.innerHTML = icon("user-plus");
      follow.addEventListener("click", () => toggleFollow(person.id));

      row.append(image, info, follow);
      root.appendChild(row);
    });

    icons();
  }

  function renderExplore() {
    const root = $("#explore-list");
    if (!root) return;

    const query = ($("#explore-search").value || "").trim().toLowerCase();

    const matches = profiles.filter(person =>
      `${person.display_name || ""} ${person.username || ""}`
        .toLowerCase()
        .includes(query)
    );

    root.replaceChildren();

    if (!matches.length) {
      root.innerHTML = '<div class="empty-message">No people found.</div>';
      return;
    }

    matches.forEach(person => {
      const card = document.createElement("article");
      card.className = "person-card";

      const image = document.createElement("img");
      image.src = avatar(person);
      image.alt = "";

      const name = document.createElement("strong");
      name.textContent = person.display_name || person.username;

      const username = document.createElement("small");
      username.textContent = `@${person.username}`;

      const bio = document.createElement("p");
      bio.textContent = person.bio || "A member of the TALKATCH community.";

      const follow = document.createElement("button");
      follow.className = "primary-btn";
      follow.type = "button";
      follow.innerHTML = `${icon("user-plus")} Follow`;

      follow.addEventListener("click", () => toggleFollow(person.id));

      card.append(image, name, username, bio, follow);
      root.appendChild(card);
    });

    icons();
  }

  async function toggleFollow(targetId) {
    if (!targetId || targetId === user.id) return;

    const { data: existing, error: findError } = await db
      .from("follows")
      .select("follower_id,following_id")
      .eq("follower_id", user.id)
      .eq("following_id", targetId)
      .maybeSingle();

    if (findError) {
      console.error(findError);
      toast("Unable to update follow. Check database policies.");
      return;
    }

    if (existing) {
      const { error } = await db
        .from("follows")
        .delete()
        .eq("follower_id", user.id)
        .eq("following_id", targetId);

      if (error) {
        toast(error.message);
        return;
      }

      toast("Unfollowed.");
    } else {
      const { error } = await db.from("follows").insert({
        follower_id: user.id,
        following_id: targetId
      });

      if (error) {
        toast(error.message);
        return;
      }

      await createNotification(
        targetId,
        "follow",
        `${profile?.display_name || "Someone"} started following you.`
      );

      toast("Now following.");
    }

    await renderProfilePage(user.id);
  }

  async function uploadFile(bucket, file, folder) {
    if (!file) return null;

    const extension = file.name.includes(".")
      ? file.name.split(".").pop().toLowerCase().replace(/[^a-z0-9]/g, "")
      : "bin";

    const path = `${folder}/${crypto.randomUUID()}.${extension}`;

    const { error } = await db.storage
      .from(bucket)
      .upload(path, file, {
        upsert: false,
        contentType: file.type || "application/octet-stream"
      });

    if (error) throw error;

    const { data } = db.storage.from(bucket).getPublicUrl(path);

    return { path, url: data.publicUrl };
  }

  async function publishPost() {
    const content = $("#post-content").value.trim();

    if (!content && !pendingPostFile) {
      toast("Write something or attach an image.");
      return;
    }

    const button = $("#publish-post");
    button.disabled = true;

    try {
      let imageUrl = null;
      let imagePath = null;

      if (pendingPostFile) {
        if (pendingPostFile.size > MAX_IMAGE_SIZE) {
          throw new Error("Post images must be 5 MB or smaller.");
        }

        if (!["image/jpeg", "image/png", "image/webp"].includes(pendingPostFile.type)) {
          throw new Error("Please upload a JPG, PNG, or WebP image.");
        }

        const uploaded = await uploadFile(
          BUCKET_POSTS,
          pendingPostFile,
          user.id
        );

        imageUrl = uploaded.url;
        imagePath = uploaded.path;
      }

      const { error } = await db.from("posts").insert({
        user_id: user.id,
        content,
        image_url: imageUrl,
        image_path: imagePath
      });

      if (error) throw error;

      $("#post-content").value = "";
      pendingPostFile = null;
      $("#post-image").value = "";
      $("#post-image-preview").hidden = true;

      toast("Your post has been published.");
      await loadFeed();
    } catch (error) {
      console.error(error);
      toast(error.message || "Unable to publish your post.");
    } finally {
      button.disabled = false;
    }
  }

  async function loadFeed() {
    const root = $("#feed-list");
    if (!root || !user) return;

    root.innerHTML = '<div class="loading">Loading posts...</div>';

    const { data, error } = await db
      .from("posts")
      .select(`
        id,user_id,content,image_url,created_at,
        profiles:user_id(id,username,display_name,avatar_url)
      `)
      .order("created_at", { ascending: false })
      .limit(50);

    if (error) {
      console.error("Feed loading failed:", error);
      root.innerHTML = '<div class="empty-message">Unable to load posts. Check your SQL setup.</div>';
      return;
    }

    root.replaceChildren();

    if (!data?.length) {
      root.innerHTML = '<div class="card empty-message">No posts yet. Be the first to share something.</div>';
      return;
    }

    for (const post of data) {
      await renderPost(post, root);
    }

    icons();
  }

  async function renderPost(post, root) {
    const author = post.profiles || {
      id: post.user_id,
      username: "user",
      display_name: "Community member"
    };

    const article = document.createElement("article");
    article.className = "post-card";
    article.dataset.postId = post.id;

    const header = document.createElement("div");
    header.className = "post-header";

    const image = document.createElement("img");
    image.className = "avatar";
    image.src = avatar(author);
    image.alt = "";

    const authorBlock = document.createElement("div");
    authorBlock.className = "post-author";

    const authorName = document.createElement("strong");
    authorName.textContent = author.display_name || author.username;

    const time = document.createElement("small");
    time.textContent =
      `@${author.username} · ${new Date(post.created_at).toLocaleString()}`;

    authorBlock.append(authorName, time);
    header.append(image, authorBlock);

    const content = document.createElement("div");
    content.className = "post-content";
    content.textContent = post.content || "";

    article.append(header);

    if (post.content) article.append(content);

    if (post.image_url) {
      const postImage = document.createElement("img");
      postImage.className = "post-image";
      postImage.src = post.image_url;
      postImage.alt = "Post attachment";
      postImage.loading = "lazy";
      article.append(postImage);
    }

    const stats = document.createElement("div");
    stats.className = "post-stats";
    stats.innerHTML = `
      <span class="like-count">Loading likes...</span>
      <span class="comment-count">Comments</span>
    `;

    const actions = document.createElement("div");
    actions.className = "post-actions";

    const likeButton = document.createElement("button");
    likeButton.className = "post-action";
    likeButton.innerHTML = `${icon("heart")} Like`;

    const commentButton = document.createElement("button");
    commentButton.className = "post-action";
    commentButton.innerHTML = `${icon("message-circle")} Comment`;

    const shareButton = document.createElement("button");
    shareButton.className = "post-action";
    shareButton.innerHTML = `${icon("share-2")} Share`;

    actions.append(likeButton, commentButton, shareButton);

    const comments = document.createElement("div");
    comments.className = "comments";
    comments.hidden = true;

    const commentForm = document.createElement("form");
    commentForm.className = "comment-form";

    const commentInput = document.createElement("input");
    commentInput.maxLength = 2000;
    commentInput.placeholder = "Write a comment...";

    const commentSubmit = document.createElement("button");
    commentSubmit.type = "submit";
    commentSubmit.innerHTML = icon("send");
    commentSubmit.setAttribute("aria-label", "Send comment");

    commentForm.append(commentInput, commentSubmit);
    comments.appendChild(commentForm);

    article.append(stats, actions, comments);
    root.appendChild(article);

    const [likesResult, commentsResult, myLikeResult] = await Promise.all([
      db.from("likes").select("user_id", { count: "exact", head: true })
        .eq("post_id", post.id),

      db.from("comments")
        .select(`
          id,content,user_id,created_at,
          profiles:user_id(username,display_name,avatar_url)
        `)
        .eq("post_id", post.id)
        .order("created_at", { ascending: true })
        .limit(50),

      db.from("likes").select("post_id")
        .eq("post_id", post.id)
        .eq("user_id", user.id)
        .maybeSingle()
    ]);

    if (likesResult.error) console.error(likesResult.error);
    if (commentsResult.error) console.error(commentsResult.error);
    if (myLikeResult.error) console.error(myLikeResult.error);

    const likeCount = likesResult.count || 0;
    const commentRows = commentsResult.data || [];
    const liked = Boolean(myLikeResult.data);

    stats.querySelector(".like-count").textContent =
      `${likeCount} ${likeCount === 1 ? "like" : "likes"}`;

    stats.querySelector(".comment-count").textContent =
      `${commentRows.length} ${commentRows.length === 1 ? "comment" : "comments"}`;

    likeButton.classList.toggle("liked", liked);
    likeButton.innerHTML = `${icon("heart")} ${liked ? "Liked" : "Like"}`;

    likeButton.addEventListener("click", async () => {
      likeButton.disabled = true;

      try {
        if (likeButton.classList.contains("liked")) {
          const { error } = await db.from("likes")
            .delete()
            .eq("post_id", post.id)
            .eq("user_id", user.id);

          if (error) throw error;

          likeButton.classList.remove("liked");
          likeButton.innerHTML = `${icon("heart")} Like`;
        } else {
          const { error } = await db.from("likes").insert({
            post_id: post.id,
            user_id: user.id
          });

          if (error && error.code !== "23505") throw error;

          likeButton.classList.add("liked");
          likeButton.innerHTML = `${icon("heart")} Liked`;
        }

        const { count } = await db.from("likes")
          .select("*", { count: "exact", head: true })
          .eq("post_id", post.id);

        stats.querySelector(".like-count").textContent =
          `${count || 0} ${(count || 0) === 1 ? "like" : "likes"}`;

        if (post.user_id !== user.id) {
          await createNotification(
            post.user_id,
            "like",
            `${profile.display_name} liked your post.`
          );
        }
      } catch (error) {
        console.error(error);
        toast("Unable to update like.");
      } finally {
        likeButton.disabled = false;
        icons();
      }
    });

    commentButton.addEventListener("click", () => {
      comments.hidden = !comments.hidden;
      commentInput.focus();
    });

    shareButton.addEventListener("click", async () => {
      const shareUrl = `${location.origin}${location.pathname}#post-${post.id}`;

      try {
        if (navigator.share) {
          await navigator.share({
            title: "TALKATCH post",
            text: post.content || "Check out this post",
            url: shareUrl
          });
        } else {
          await navigator.clipboard.writeText(shareUrl);
          toast("Post link copied.");
        }
      } catch (error) {
        if (error.name !== "AbortError") toast("Unable to share post.");
      }
    });

    commentRows.forEach(comment => {
      addCommentElement(comments, comment);
    });

    commentForm.addEventListener("submit", async event => {
      event.preventDefault();

      const text = commentInput.value.trim();
      if (!text) return;

      commentSubmit.disabled = true;

      try {
        const { data, error } = await db.from("comments")
          .insert({
            post_id: post.id,
            user_id: user.id,
            content: text
          })
          .select(`
            id,content,user_id,created_at,
            profiles:user_id(username,display_name,avatar_url)
          `)
          .single();

        if (error) throw error;

        addCommentElement(comments, data, commentForm);
        commentInput.value = "";

        const count = comments.querySelectorAll(".comment").length;
        stats.querySelector(".comment-count").textContent =
          `${count} ${count === 1 ? "comment" : "comments"}`;

        if (post.user_id !== user.id) {
          await createNotification(
            post.user_id,
            "comment",
            `${profile.display_name} commented on your post.`
          );
        }
      } catch (error) {
        console.error(error);
        toast("Unable to publish comment.");
      } finally {
        commentSubmit.disabled = false;
      }
    });
  }

  function addCommentElement(root, comment, beforeElement) {
    const row = document.createElement("div");
    row.className = "comment";

    const image = document.createElement("img");
    image.src = avatar(comment.profiles);
    image.alt = "";

    const body = document.createElement("div");
    body.className = "comment-body";

    const name = document.createElement("strong");
    name.textContent = comment.profiles?.display_name ||
      comment.profiles?.username || "Member";

    const text = document.createElement("p");
    text.textContent = comment.content;

    body.append(name, text);
    row.append(image, body);

    root.insertBefore(row, beforeElement || null);
  }

  async function createNotification(recipientId, type, message) {
    if (!recipientId || recipientId === user.id) return;

    const { error } = await db.from("notifications").insert({
      user_id: recipientId,
      actor_id: user.id,
      type,
      message
    });

    if (error) {
      console.warn("Notification could not be created:", error.message);
    }
  }

  async function loadNotifications() {
    const root = $("#notifications-list");
    if (!root || !user) return;

    const { data, error } = await db.from("notifications")
      .select(`
        id,type,message,created_at,actor_id,
        profiles:actor_id(username,display_name,avatar_url)
      `)
      .eq("user_id", user.id)
      .order("created_at", { ascending: false })
      .limit(50);

    if (error) {
      console.error("Notification loading failed:", error);
      root.innerHTML = '<p class="muted">Unable to load notifications. Check your notifications table and policies.</p>';
      return;
    }

    root.replaceChildren();

    if (!data?.length) {
      root.innerHTML = '<p class="muted">You have no notifications yet.</p>';
      return;
    }

    data.forEach(notification => {
      const row = document.createElement("div");
      row.className = "notification";

      const text = document.createElement("div");
      text.textContent = notification.message || notification.type;

      const time = document.createElement("small");
      time.textContent = new Date(notification.created_at).toLocaleString();

      row.append(text, time);
      root.appendChild(row);
    });
  }

  async function renderProfilePage(profileId) {
    const root = $("#profile-page");
    if (!root) return;

    const isMine = profileId === user.id;

    let person = isMine ? profile : profiles.find(p => p.id === profileId);

    if (!person) {
      const { data } = await db.from("profiles")
        .select("*")
        .eq("id", profileId)
        .maybeSingle();

      person = data;
    }

    if (!person) {
      root.innerHTML = '<p class="muted">Profile not found.</p>';
      return;
    }

    const [postsResult, followersResult, followingResult] = await Promise.all([
      db.from("posts")
        .select(`
          id,user_id,content,image_url,created_at,
          profiles:user_id(id,username,display_name,avatar_url)
        `)
        .eq("user_id", profileId)
        .order("created_at", { ascending: false })
        .limit(30),

      db.from("follows")
        .select("*", { count: "exact", head: true })
        .eq("following_id", profileId),

      db.from("follows")
        .select("*", { count: "exact", head: true })
        .eq("follower_id", profileId)
    ]);

    root.replaceChildren();

    const card = document.createElement("div");
    card.className = "profile-card";

    const cover = document.createElement("div");
    cover.className = "profile-cover";

    const info = document.createElement("div");
    info.className = "profile-info";

    const image = document.createElement("img");
    image.className = "profile-main-avatar";
    image.src = avatar(person);
    image.alt = "";

    const line = document.createElement("div");
    line.className = "profile-topline";

    const text = document.createElement("div");

    const name = document.createElement("h2");
    name.textContent = person.display_name || person.username;

    const username = document.createElement("div");
    username.className = "muted";
    username.textContent = `@${person.username}`;

    text.append(name, username);

    line.append(text);

    if (isMine) {
      const edit = document.createElement("button");
      edit.className = "secondary-btn";
      edit.innerHTML = `${icon("settings")} Edit profile`;
      edit.addEventListener("click", () => {
        $("#profile-modal").hidden = false;
        icons();
      });
      line.appendChild(edit);
    } else {
      const follow = document.createElement("button");
      follow.className = "primary-btn";
      follow.innerHTML = `${icon("user-plus")} Follow`;
      follow.addEventListener("click", () => toggleFollow(profileId));
      line.appendChild(follow);
    }

    const bio = document.createElement("p");
    bio.textContent = person.bio || "No bio added yet.";

    const stats = document.createElement("div");
    stats.className = "profile-stats";

    stats.innerHTML = `
      <div><strong>${postsResult.data?.length || 0}</strong><span>Posts</span></div>
      <div><strong>${followersResult.count || 0}</strong><span>Followers</span></div>
      <div><strong>${followingResult.count || 0}</strong><span>Following</span></div>
    `;

    info.append(image, line, bio, stats);
    card.append(cover, info);
    root.appendChild(card);

    const heading = document.createElement("h2");
    heading.textContent = isMine ? "Your posts" : "Posts";
    root.appendChild(heading);

    const feed = document.createElement("div");
    feed.className = "feed-list";
    root.appendChild(feed);

    (postsResult.data || []).forEach(post => {
      // Render individual profile posts through the common post renderer.
      renderPost(post, feed);
    });

    if (postsResult.error) {
      console.error(postsResult.error);
      toast("Unable to load profile posts.");
    }

    icons();
  }

  async function saveProfile(event) {
    event.preventDefault();

    const displayName = $("#edit-display-name").value.trim();
    const username = $("#edit-username").value.trim();
    const bio = $("#edit-bio").value.trim();

    if (!/^[A-Za-z0-9_]{3,24}$/.test(username)) {
      toast("Username must be 3–24 letters, numbers, or underscores.");
      return;
    }

    const submit = event.submitter;
    if (submit) submit.disabled = true;

    try {
      const changes = {
        id: user.id,
        display_name: displayName,
        username,
        bio
      };

      if (pendingAvatarFile) {
        if (pendingAvatarFile.size > MAX_IMAGE_SIZE) {
          throw new Error("Profile pictures must be 5 MB or smaller.");
        }

        if (!["image/jpeg", "image/png", "image/webp"].includes(pendingAvatarFile.type)) {
          throw new Error("Use a JPG, PNG, or WebP image.");
        }

        const uploaded = await uploadFile(
          BUCKET_AVATARS,
          pendingAvatarFile,
          user.id
        );

        changes.avatar_url = uploaded.url;
      }

      const { error } = await db.from("profiles")
        .update(changes)
        .eq("id", user.id);

      if (error) throw error;

      pendingAvatarFile = null;

      await loadProfile();
      await loadPeople();

      $("#profile-modal").hidden = true;
      toast("Profile updated.");
      await renderProfilePage(user.id);
    } catch (error) {
      console.error(error);
      toast(error.message || "Unable to save profile.");
    } finally {
      if (submit) submit.disabled = false;
    }
  }

  function renderMessagePeople() {
    const root = $("#message-people-list");
    if (!root) return;

    const query = ($("#message-user-search").value || "").trim().toLowerCase();

    const matches = profiles.filter(person =>
      `${person.display_name || ""} ${person.username || ""}`
        .toLowerCase()
        .includes(query)
    );

    root.replaceChildren();

    matches.forEach(person => {
      const button = document.createElement("button");
      button.className = "person-card";
      button.type = "button";

      const image = document.createElement("img");
      image.src = avatar(person);
      image.alt = "";

      const name = document.createElement("strong");
      name.textContent = person.display_name || person.username;

      const username = document.createElement("small");
      username.textContent = `@${person.username}`;

      button.append(image, name, username);
      button.addEventListener("click", () => openChat(person));

      root.appendChild(button);
    });
  }

  function messageFilter(personId) {
    return `and(sender_id.eq.${user.id},recipient_id.eq.${personId}),and(sender_id.eq.${personId},recipient_id.eq.${user.id})`;
  }

  async function openChat(person) {
    selectedChat = person;

    if (chatChannel) {
      await db.removeChannel(chatChannel);
      chatChannel = null;
    }

    $("#message-empty").hidden = true;
    $("#chat-panel").hidden = false;

    $("#chat-avatar").src = avatar(person);
    $("#chat-name").textContent = person.display_name || person.username;
    $("#chat-username").textContent = `@${person.username}`;

    await loadChatMessages();

    chatChannel = db.channel(
      `messages:${[user.id, person.id].sort().join(":")}`
    ).on(
      "postgres_changes",
      { event: "INSERT", schema: "public", table: "messages" },
      payload => {
        const message = payload.new;

        if (
          (message.sender_id === user.id && message.recipient_id === selectedChat?.id) ||
          (message.sender_id === selectedChat?.id && message.recipient_id === user.id)
        ) {
          appendChatMessage(message);
        }
      }
    ).subscribe();

    icons();
  }

  async function loadChatMessages() {
    if (!selectedChat) return;

    const root = $("#chat-messages");
    root.replaceChildren();

    const { data, error } = await db.from("messages")
      .select("*")
      .or(messageFilter(selectedChat.id))
      .order("created_at", { ascending: true })
      .limit(100);

    if (error) {
      console.error(error);
      toast("Unable to load messages. Check your messages table.");
      return;
    }

    (data || []).forEach(appendChatMessage);
  }

  function appendChatMessage(message) {
    const root = $("#chat-messages");

    if (root.querySelector(`[data-message-id="${CSS.escape(message.id)}"]`)) {
      return;
    }

    const mine = message.sender_id === user.id;
    const bubble = document.createElement("div");

    bubble.className = `chat-message ${mine ? "mine" : ""}`;
    bubble.dataset.messageId = message.id;

    if (message.content) {
      const text = document.createElement("div");
      text.textContent = message.content;
      bubble.appendChild(text);
    }

    if (message.file_url) {
      const link = document.createElement("a");
      link.href = message.file_url;
      link.target = "_blank";
      link.rel = "noopener noreferrer";
      link.textContent = `Attachment: ${message.file_name || "Open file"}`;
      link.style.textDecoration = "underline";
      bubble.appendChild(link);
    }

    const time = document.createElement("small");
    time.textContent = new Date(message.created_at).toLocaleTimeString([], {
      hour: "2-digit",
      minute: "2-digit"
    });

    bubble.appendChild(time);
    root.appendChild(bubble);
    root.scrollTop = root.scrollHeight;
  }

  async function sendChatMessage(event) {
    event.preventDefault();

    if (!selectedChat) {
      toast("Choose a user first.");
      return;
    }

    const input = $("#chat-input");
    const content = input.value.trim();
    const file = $("#chat-file").files?.[0];

    if (!content && !file) return;

    if (file && file.size > MAX_FILE_SIZE) {
      toast("Attachments must be 15 MB or smaller.");
      return;
    }

    const button = event.submitter;
    if (button) button.disabled = true;

    try {
      const row = {
        sender_id: user.id,
        recipient_id: selectedChat.id,
        content: content || null
      };

      if (file) {
        const uploaded = await uploadFile(
          BUCKET_FILES,
          file,
          user.id
        );

        row.file_url = uploaded.url;
        row.file_path = uploaded.path;
        row.file_name = file.name;
        row.file_type = file.type || "application/octet-stream";
      }

      const { data, error } = await db.from("messages")
        .insert(row)
        .select()
        .single();

      if (error) throw error;

      appendChatMessage(data);
      input.value = "";
      $("#chat-file").value = "";
    } catch (error) {
      console.error(error);
      toast(error.message || "Unable to send message.");
    } finally {
      if (button) button.disabled = false;
    }
  }

  function startFeedRealtime() {
    if (feedChannel) db.removeChannel(feedChannel);

    feedChannel = db.channel("talkatch-feed")
      .on(
        "postgres_changes",
        { event: "INSERT", schema: "public", table: "posts" },
        () => {
          if (!$("#view-home").hidden) loadFeed();
        }
      )
      .subscribe();
  }

  async function logout() {
    if (chatChannel) await db.removeChannel(chatChannel);
    if (feedChannel) await db.removeChannel(feedChannel);

    await db.auth.signOut();

    user = null;
    profile = null;
    profiles = [];
    selectedChat = null;
    chatChannel = null;
    feedChannel = null;

    showAuth();
    setAuthMode("login");
  }

  function bindEvents() {
    $("#login-tab").addEventListener("click", () => setAuthMode("login"));
    $("#signup-tab").addEventListener("click", () => setAuthMode("signup"));

    $("#loginForm").addEventListener("submit", async event => {
      event.preventDefault();

      const form = new FormData(event.currentTarget);

      try {
        const { data, error } = await db.auth.signInWithPassword({
          email: String(form.get("email")).trim(),
          password: String(form.get("password"))
        });

        if (error) throw error;

        await enterApp(data.user);
      } catch (error) {
        setMessage(error.message || "Unable to log in.");
      }
    });

    $("#signupForm").addEventListener("submit", async event => {
      event.preventDefault();

      const form = new FormData(event.currentTarget);

      const displayName = String(form.get("display_name")).trim();
      const username = String(form.get("username")).trim();
      const email = String(form.get("email")).trim();
      const password = String(form.get("password"));

      if (!/^[A-Za-z0-9_]{3,24}$/.test(username)) {
        setMessage("Username must be 3–24 letters, numbers, or underscores.");
        return;
      }

      try {
        const { data, error } = await db.auth.signUp({
          email,
          password,
          options: {
            data: { display_name: displayName, username },
            emailRedirectTo: location.origin
          }
        });

        if (error) throw error;

        if (data.session && data.user) {
          await enterApp(data.user);
        } else {
          setMessage("Registration submitted. Check your email and confirm your account before logging in.");
        }
      } catch (error) {
        setMessage(error.message || "Unable to create your account.");
      }
    });

    $("#forgot-password").addEventListener("click", async () => {
      const email = $("#login-email").value.trim();

      if (!email) {
        setMessage("Enter your email address first.");
        return;
      }

      const { error } = await db.auth.resetPasswordForEmail(email, {
        redirectTo: location.origin
      });

      setMessage(error ? error.message : "If the account exists, a password reset email will be sent.");
    });

    $("#publish-post").addEventListener("click", publishPost);

    $("#post-image").addEventListener("change", event => {
      const file = event.target.files?.[0];
      if (!file) return;

      if (file.size > MAX_IMAGE_SIZE) {
        toast("Images must be 5 MB or smaller.");
        event.target.value = "";
        return;
      }

      pendingPostFile = file;
      $("#preview-image").src = URL.createObjectURL(file);
      $("#post-image-preview").hidden = false;
    });

    $("#remove-post-image").addEventListener("click", () => {
      pendingPostFile = null;
      $("#post-image").value = "";
      $("#post-image-preview").hidden = true;
    });

    $("#refresh-feed").addEventListener("click", loadFeed);
    $("#refresh-notifications").addEventListener("click", loadNotifications);
    $("#refresh-suggestions").addEventListener("click", loadPeople);

    $("#explore-search").addEventListener("input", renderExplore);
    $("#message-user-search").addEventListener("input", renderMessagePeople);

    $("#chat-form").addEventListener("submit", sendChatMessage);

    $("#chat-file").addEventListener("change", event => {
      const file = event.target.files?.[0];
      if (file) toast(`Selected attachment: ${file.name}. Press Send to upload it.`);
    });

    $("#profileForm").addEventListener("submit", saveProfile);

    $("#profile-avatar-file").addEventListener("change", event => {
      const file = event.target.files?.[0];
      if (!file) return;

      pendingAvatarFile = file;
      $("#profile-avatar-preview").src = URL.createObjectURL(file);
    });

    $("#open-profile").addEventListener("click", () => {
      $("#profile-modal").hidden = false;
      icons();
    });

    $("#close-profile").addEventListener("click", () => {
      $("#profile-modal").hidden = true;
    });

    $("#logout-btn").addEventListener("click", logout);

    const toggleTheme = () => {
      const dark = document.body.classList.toggle("dark");
      localStorage.setItem("talkatch-theme", dark ? "dark" : "light");
      icons();
    };

    $("#theme-toggle").addEventListener("click", toggleTheme);
    $("#mobile-theme-toggle").addEventListener("click", toggleTheme);

    $$("[data-view]").forEach(button => {
      button.addEventListener("click", () => switchView(button.dataset.view));
    });
  }

  async function init() {
    if (!window.supabase) {
      showAuth();
      setMessage("Supabase failed to load. Check your internet connection.");
      return;
    }

    if (
      !config.supabaseUrl ||
      !config.supabasePublishableKey ||
      config.supabasePublishableKey.includes("PASTE_YOUR")
    ) {
      showAuth();
      setMessage("Add your Supabase URL and public key to config.js.");
      return;
    }

    db = window.supabase.createClient(
      config.supabaseUrl,
      config.supabasePublishableKey
    );

    bindEvents();

    if (localStorage.getItem("talkatch-theme") === "dark") {
      document.body.classList.add("dark");
    }

    const { data, error } = await db.auth.getSession();

    if (error) console.error("Session check failed:", error);

    if (data?.session?.user) {
      await enterApp(data.session.user);
    } else {
      showAuth();
    }

    db.auth.onAuthStateChange((event, session) => {
      if (event === "SIGNED_OUT") showAuth();
    });

    icons();
  }

  document.addEventListener("DOMContentLoaded", init);
})();
