(() => {
  'use strict';

  const cfg = window.TALKATCH_CONFIG;

  if (!cfg?.supabaseUrl ||
      !cfg?.supabasePublishableKey ||
      !window.supabase?.createClient) {
    console.error('TALKATCH: Check config.js and Supabase JS.');
    return;
  }

  const db = window.supabase.createClient(
    cfg.supabaseUrl,
    cfg.supabasePublishableKey,
    {
      auth: {
        persistSession: true,
        autoRefreshToken: true,
        detectSessionInUrl: true
      }
    }
  );

  const $ = (s, r = document) => r.querySelector(s);
  const $$ = (s, r = document) => [...r.querySelectorAll(s)];

  const state = {
    user: null,
    profile: null,
    view: 'feed'
  };

  const esc = s => String(s ?? '').replace(/[&<>"']/g, c => ({
    '&': '&amp;',
    '<': '&lt;',
    '>': '&gt;',
    '"': '&quot;',
    "'": '&#39;'
  })[c]);

  const initials = s => (s || 'T').trim().slice(0, 1).toUpperCase();

  const val = (form, name) =>
    String(new FormData(form).get(name) || '').trim();

  function toast(message, error = false) {
    const t = $('#toast');
    t.textContent = message;
    t.classList.toggle('error', error);
    t.style.display = 'block';

    clearTimeout(toast.timer);
    toast.timer = setTimeout(() => {
      t.style.display = 'none';
    }, 5000);
  }

  function errorText(e) {
    const m = e?.message || 'Something went wrong.';

    if (/invalid login credentials/i.test(m))
      return 'Incorrect email or password.';

    if (/email not confirmed/i.test(m))
      return 'Confirm your email before logging in.';

    if (/already registered/i.test(m))
      return 'That email is already registered. Try logging in.';

    if (/rate limit/i.test(m))
      return 'Too many attempts. Please wait and try again.';

    return m;
  }

  function showAuth(tab = 'login') {
    $('#auth').hidden = false;
    $('#app').hidden = true;
    $('#mobile').hidden = true;

    $$('[data-tab]').forEach(b => {
      b.classList.toggle('active', b.dataset.tab === tab);
    });

    $('#loginForm').hidden = tab !== 'login';
    $('#signupForm').hidden = tab !== 'signup';
  }

  function avatar(img, fallback, url, name) {
    img.hidden = !url;
    fallback.hidden = !!url;
    fallback.textContent = initials(name);

    if (url) img.src = url;

    img.onerror = () => {
      img.hidden = true;
      fallback.hidden = false;
    };
  }

  function theme(value) {
    document.body.dataset.theme = value;
    localStorage.setItem('talkatch-theme', value);
  }

  function accent(color) {
    document.documentElement.style.setProperty('--accent', color);
    localStorage.setItem('talkatch-accent', color);
  }

  async function ensureProfile(user, username = '') {
    const existing = await db
      .from('profiles')
      .select('*')
      .eq('id', user.id)
      .maybeSingle();

    if (existing.error) throw existing.error;
    if (existing.data) return existing.data;

    const u = username ||
      user.user_metadata?.username ||
      user.email.split('@')[0];

    const result = await db
      .from('profiles')
      .insert({
        id: user.id,
        username: u,
        display_name: user.user_metadata?.display_name || u,
        bio: '',
        avatar_url: null
      })
      .select()
      .single();

    if (result.error) {
      const retry = await db
        .from('profiles')
        .select('*')
        .eq('id', user.id)
        .maybeSingle();

      if (retry.data) return retry.data;
      throw result.error;
    }

    return result.data;
  }

  async function loadProfile() {
    const result = await db
      .from('profiles')
      .select('*')
      .eq('id', state.user.id)
      .maybeSingle();

    if (result.error) throw result.error;

    state.profile = result.data ||
      await ensureProfile(state.user);

    const p = state.profile;
    const name = p.display_name || p.username || state.user.email;

    $('#sideName').textContent = name;
    $('#sideHandle').textContent = '@' + (p.username || 'user');

    avatar(
      $('#sidePhoto'),
      $('#sideInitial'),
      p.avatar_url,
      name
    );

    $('#composeInitial').textContent = initials(name);

    $('#profileForm').elements.username.value = p.username || '';
    $('#profileForm').elements.display_name.value = p.display_name || '';
    $('#profileForm').elements.bio.value = p.bio || '';

    avatar(
      $('#profilePhoto'),
      $('#profileInitial'),
      p.avatar_url,
      name
    );
  }

  function setView(name) {
    state.view = name;

    $$('.view').forEach(view => {
      view.hidden = view.id !== name + 'View';
    });

    $$('[data-view]').forEach(button => {
      button.classList.toggle(
        'selected',
        button.dataset.view === name
      );
    });

    if (name === 'feed') loadFeed();
    if (name === 'discover') loadPeople();
    if (name === 'notifications') loadNotifications();

    if (name === 'profile') {
      loadProfile().catch(e => toast(errorText(e), true));
    }
  }

  async function init(session) {
    state.user = session?.user || null;

    if (!state.user) {
      showAuth();
      return;
    }

    $('#auth').hidden = true;
    $('#app').hidden = false;
    $('#mobile').hidden = false;

    try {
      await loadProfile();
      setView(state.view);
    } catch (e) {
      console.error(e);
      toast(
        'Signed in, but profile loading failed: ' + errorText(e),
        true
      );
    }
  }

  async function signup(e) {
    e.preventDefault();

    const form = e.currentTarget;
    const username = val(form, 'username');
    const email = val(form, 'email').toLowerCase();
    const password = val(form, 'password');

    if (!/^[A-Za-z0-9_]{3,24}$/.test(username)) {
      return toast(
        'Username must be 3–24 letters, numbers, or underscores.',
        true
      );
    }

    if (password.length < 8) {
      return toast('Password must be at least 8 characters.', true);
    }

    const button = $('button[type=submit]', form);
    button.disabled = true;

    try {
      const { data, error } = await db.auth.signUp({
        email,
        password,
        options: {
          emailRedirectTo: location.origin + '/',
          data: {
            username,
            display_name: username
          }
        }
      });

      if (error) throw error;

      if (data.session) {
        await ensureProfile(data.user, username);
        await init(data.session);
        toast('Account created.');
      } else {
        toast(
          'Account submitted. Check your email and click the confirmation link before logging in.'
        );
      }
    } catch (e) {
      console.error(e);
      toast(errorText(e), true);
    } finally {
      button.disabled = false;
    }
  }

  async function login(e) {
    e.preventDefault();

    const form = e.currentTarget;
    const button = $('button[type=submit]', form);
    button.disabled = true;

    try {
      const { data, error } = await db.auth.signInWithPassword({
        email: val(form, 'email').toLowerCase(),
        password: val(form, 'password')
      });

      if (error) throw error;

      await init(data.session);
      toast('Welcome back.');
    } catch (e) {
      console.error(e);
      toast(errorText(e), true);
    } finally {
      button.disabled = false;
    }
  }

  async function logout() {
    const { error } = await db.auth.signOut({ scope: 'local' });

    if (error) return toast(errorText(error), true);

    state.user = null;
    state.profile = null;
    showAuth('login');
    toast('Logged out. Your account remains saved.');
  }

  async function reset() {
    const email = prompt('Enter your account email:');
    if (!email) return;

    const { error } = await db.auth.resetPasswordForEmail(
      email.trim().toLowerCase(),
      { redirectTo: location.origin + '/' }
    );

    if (error) return toast(errorText(error), true);

    toast('If the account exists, a password reset email has been requested.');
  }

  async function saveProfile(e) {
    e.preventDefault();

    const form = e.currentTarget;
    const username = val(form, 'username');

    if (!/^[A-Za-z0-9_]{3,24}$/.test(username)) {
      return toast(
        'Username must be 3–24 letters, numbers, or underscores.',
        true
      );
    }

    const { data, error } = await db
      .from('profiles')
      .update({
        username,
        display_name: val(form, 'display_name') || username,
        bio: val(form, 'bio')
      })
      .eq('id', state.user.id)
      .select()
      .single();

    if (error) return toast(errorText(error), true);

    state.profile = data;
    await loadProfile();
    toast('Profile saved.');
  }

  async function uploadPhoto(e) {
    const file = e.target.files?.[0];
    if (!file) return;

    if (!['image/jpeg', 'image/png', 'image/webp'].includes(file.type)) {
      return toast('Choose a JPG, PNG, or WebP image.', true);
    }

    if (file.size > 3 * 1024 * 1024) {
      return toast('Image must be under 3 MB.', true);
    }

    const ext = file.type === 'image/png'
      ? 'png'
      : file.type === 'image/webp'
        ? 'webp'
        : 'jpg';

    const path = `${state.user.id}/avatar-${Date.now()}.${ext}`;

    const upload = await db.storage
      .from('avatars')
      .upload(path, file, {
        upsert: true,
        contentType: file.type
      });

    if (upload.error) {
      console.error(upload.error);
      return toast(
        "Upload failed. Create the public 'avatars' bucket and configure its Storage policies in Supabase.",
        true
      );
    }

    const url = db.storage
      .from('avatars')
      .getPublicUrl(path).data.publicUrl;

    const { data, error } = await db
      .from('profiles')
      .update({ avatar_url: url })
      .eq('id', state.user.id)
      .select()
      .single();

    if (error) return toast(errorText(error), true);

    state.profile = data;
    await loadProfile();
    toast('Profile photo updated.');
    e.target.value = '';
  }

  async function createPost(e) {
    e.preventDefault();

    const content = val(e.currentTarget, 'content');
    if (!content) return;

    const { error } = await db
      .from('posts')
      .insert({
        user_id: state.user.id,
        content
      });

    if (error) return toast(errorText(error), true);

    e.currentTarget.reset();
    await loadFeed();
    toast('Post published.');
  }

  async function loadFeed() {
    const box = $('#feed');
    box.innerHTML = '<div class="panel">Loading posts…</div>';

    const { data: posts, error } = await db
      .from('posts')
      .select('id,user_id,content,created_at')
      .order('created_at', { ascending: false })
      .limit(50);

    if (error) {
      console.error(error);
      box.innerHTML =
        '<div class="panel">Unable to load posts. Check your posts table and RLS policies.</div>';
      return;
    }

    if (!posts?.length) {
      box.innerHTML =
        '<div class="panel">No posts yet. Share the first update.</div>';
      return;
    }

    const ids = [...new Set(posts.map(p => p.user_id))];
    const postIds = posts.map(p => p.id);

    const [profilesResult, likesResult] = await Promise.all([
      db.from('profiles')
        .select('id,username,display_name,avatar_url')
        .in('id', ids),

      db.from('likes')
        .select('post_id,user_id')
        .in('post_id', postIds)
    ]);

    const people = Object.fromEntries(
      (profilesResult.data || []).map(p => [p.id, p])
    );

    const likes = likesResult.data || [];

    box.innerHTML = posts.map(post => {
      const person = people[post.user_id] || {};
      const name = person.display_name || person.username || 'Member';

      const liked = likes.some(like =>
        like.post_id === post.id &&
        like.user_id === state.user.id
      );

      const count = likes.filter(
        like => like.post_id === post.id
      ).length;

      return `
        <article class="post" data-post="${esc(post.id)}">
          <header class="posthead">
            <div class="avatar">
              ${person.avatar_url
                ? `<img src="${esc(person.avatar_url)}" alt="">`
                : esc(initials(name))}
            </div>
            <div>
              <strong>${esc(name)}</strong>
              <small>
                @${esc(person.username || 'member')} ·
                ${esc(post.created_at
                  ? new Date(post.created_at).toLocaleString()
                  : '')}
              </small>
            </div>
          </header>

          <p class="posttext">${esc(post.content)}</p>

          <div class="actions">
            <button data-action="like"
                    data-id="${esc(post.id)}"
                    data-liked="${liked}">
              <i data-lucide="heart"></i>
              ${liked ? 'Liked' : 'Like'} · ${count}
            </button>

            <button data-action="comments" data-id="${esc(post.id)}">
              <i data-lucide="message-circle"></i> Comment
            </button>
          </div>

          <div class="comments" hidden></div>
        </article>
      `;
    }).join('');

    window.lucide?.createIcons();
  }

  async function like(id, button) {
    const liked = button.dataset.liked === 'true';

    const result = liked
      ? await db.from('likes')
          .delete()
          .eq('post_id', id)
          .eq('user_id', state.user.id)
      : await db.from('likes').insert({
          post_id: id,
          user_id: state.user.id
        });

    if (result.error) return toast(errorText(result.error), true);

    await loadFeed();
  }

  async function comments(id, article) {
    const box = $('.comments', article);

    if (!box.hidden) {
      box.hidden = true;
      return;
    }

    box.hidden = false;
    box.innerHTML = '<p>Loading comments…</p>';

    const { data, error } = await db
      .from('comments')
      .select('id,user_id,content,created_at')
      .eq('post_id', id)
      .order('created_at');

    if (error) {
      box.innerHTML =
        '<p>Comments unavailable. Check the comments table and policies.</p>';
      return;
    }

    const ids = [...new Set((data || []).map(c => c.user_id))];

    const result = ids.length
      ? await db.from('profiles')
          .select('id,username,display_name')
          .in('id', ids)
      : { data: [] };

    const people = Object.fromEntries(
      (result.data || []).map(p => [p.id, p])
    );

    box.innerHTML =
      (data || []).map(comment => `
        <div class="comment">
          <strong>
            ${esc(
              people[comment.user_id]?.display_name ||
              people[comment.user_id]?.username ||
              'Member'
            )}
          </strong>
          ${esc(comment.content)}
        </div>
      `).join('') +
      `
        <form class="commentform" data-post="${esc(id)}">
          <input name="content" maxlength="2000"
                 placeholder="Write a comment…" required>
          <button aria-label="Send" type="submit">
            <i data-lucide="send"></i>
          </button>
        </form>
      `;

    window.lucide?.createIcons();
  }

  async function submitComment(e) {
    e.preventDefault();

    const id = e.currentTarget.dataset.post;
    const content = val(e.currentTarget, 'content');

    if (!content) return;

    const { error } = await db.from('comments').insert({
      post_id: id,
      user_id: state.user.id,
      content
    });

    if (error) return toast(errorText(error), true);

    await comments(id, e.currentTarget.closest('.post'));
    toast('Comment added.');
  }

  async function loadPeople(term = '') {
    const box = $('#people');
    box.innerHTML = '<div class="panel">Loading people…</div>';

    let query = db.from('profiles')
      .select('id,username,display_name,bio,avatar_url')
      .order('username')
      .limit(100);

    if (term) query = query.ilike('username', `%${term}%`);

    const { data, error } = await query;

    if (error) {
      box.innerHTML =
        '<div class="panel">Unable to load profiles. Check table access.</div>';
      return;
    }

    const people = (data || []).filter(
      person => person.id !== state.user.id
    );

    if (!people.length) {
      box.innerHTML =
        '<div class="panel">No matching members found.</div>';
      return;
    }

    const result = await db.from('follows')
      .select('following_id')
      .eq('follower_id', state.user.id);

    const following = new Set(
      (result.data || []).map(row => row.following_id)
    );

    box.innerHTML = people.map(person => `
      <article class="person">
        ${person.avatar_url
          ? `<img class="avatar" src="${esc(person.avatar_url)}" alt="">`
          : `<b class="avatar">${esc(initials(person.display_name || person.username))}</b>`}

        <h3>${esc(person.display_name || person.username || 'Member')}</h3>
        <p>@${esc(person.username || 'member')}</p>
        <p>${esc(person.bio || 'A TALKATCH community member.')}</p>

        <button class="secondary"
                data-action="follow"
                data-user="${esc(person.id)}"
                data-following="${following.has(person.id)}">
          ${following.has(person.id) ? 'Following' : 'Follow'}
        </button>
      </article>
    `).join('');
  }

  async function follow(id, button) {
    const isFollowing = button.dataset.following === 'true';

    const result = isFollowing
      ? await db.from('follows')
          .delete()
          .eq('follower_id', state.user.id)
          .eq('following_id', id)
      : await db.from('follows').insert({
          follower_id: state.user.id,
          following_id: id
        });

    if (result.error) return toast(errorText(result.error), true);

    await loadPeople($('#search').value.trim());

    toast(isFollowing ? 'Unfollowed member.' : 'Now following member.');
  }

  async function loadNotifications() {
    const box = $('#notifications');

    const { data, error } = await db.from('notifications')
      .select('id,type,message,created_at,is_read')
      .eq('user_id', state.user.id)
      .order('created_at', { ascending: false })
      .limit(50);

    if (error) {
      box.innerHTML =
        '<div class="panel">Notifications are unavailable. Check the notifications table and policies.</div>';
      return;
    }

    box.innerHTML = data?.length
      ? data.map(notification => `
          <article class="post">
            <strong>
              ${esc(notification.message || notification.type || 'Notification')}
            </strong>
            <p>
              ${esc(notification.created_at
                ? new Date(notification.created_at).toLocaleString()
                : '')}
            </p>
          </article>
        `).join('')
      : '<div class="panel">No notifications yet.</div>';
  }

  document.addEventListener('submit', e => {
    if (e.target.id === 'loginForm') login(e);
    else if (e.target.id === 'signupForm') signup(e);
    else if (e.target.id === 'postForm') createPost(e);
    else if (e.target.id === 'profileForm') saveProfile(e);
    else if (e.target.matches('.commentform')) submitComment(e);
  });

  document.addEventListener('click', e => {
    const button = e.target.closest('button');
    if (!button) return;

    if (button.dataset.tab) return showAuth(button.dataset.tab);
    if (button.id === 'logout') return logout();
    if (button.id === 'forgot') return reset();

    if (button.id === 'theme') {
      return theme(
        document.body.dataset.theme === 'light' ? 'dark' : 'light'
      );
    }

    if (button.id === 'accent') {
      setView('settings');
      return;
    }

    if (button.id === 'refresh') return loadFeed();
    if (button.dataset.theme) return theme(button.dataset.theme);
    if (button.dataset.color) return accent(button.dataset.color);
    if (button.dataset.view) return setView(button.dataset.view);

    if (button.dataset.action === 'like')
      return like(button.dataset.id, button);

    if (button.dataset.action === 'comments')
      return comments(button.dataset.id, button.closest('.post'));

    if (button.dataset.action === 'follow')
      return follow(button.dataset.user, button);
  });

  $('#avatarFile').addEventListener('change', uploadPhoto);

  $('#search').addEventListener('keydown', e => {
    if (e.key === 'Enter' && state.user) {
      setView('discover');
      loadPeople(e.currentTarget.value.trim());
    }
  });

  theme(localStorage.getItem('talkatch-theme') || 'dark');
  accent(localStorage.getItem('talkatch-accent') || '#a78bfa');
  window.lucide?.createIcons();

  // This route is hidden from navigation, but is not an admin system.
  if (location.pathname.replace(/\/+$/, '') === '/admin') {
    document.body.innerHTML = `
      <main style="max-width:620px;margin:12vh auto;padding:24px;font:15px system-ui">
        <h1>TALKATCH Admin</h1>
        <p>
          Admin tools are not enabled yet. Configure a verified admin role
          and enforce access with Supabase RLS or secure server-side functions
          before adding admin actions.
        </p>
        <a href="/">Return to TALKATCH</a>
      </main>
    `;
    return;
  }

  db.auth.getSession()
    .then(({ data, error }) => {
      if (error) {
        console.error(error);
        return showAuth();
      }

      return init(data.session);
    })
    .catch(e => {
      console.error(e);
      showAuth();
    });

  db.auth.onAuthStateChange((event, session) => {
    if (event === 'SIGNED_OUT') {
      state.user = null;
      state.profile = null;
      showAuth();
    } else if (event === 'SIGNED_IN') {
      state.user = session?.user || null;
    }
  });

  window.TALKATCH = {
    db,
    logout,
    loadFeed,
    loadPeople,
    loadNotifications,
    setView
  };
})();
