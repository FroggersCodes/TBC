(function () {
    'use strict';

    const overlay = document.getElementById('auth-overlay');
    const btnGoogle = document.getElementById('btn-google-signin');
    const formEmail = document.getElementById('form-email-auth');
    const btnRegister = document.getElementById('btn-email-register');
    const authError = document.getElementById('auth-error');
    const btnLogout = document.getElementById('btn-logout');
    const userInfo = document.getElementById('user-info');
    const userName = document.getElementById('user-name');
    const userAvatar = document.getElementById('user-avatar');

    function showError(msg) {
        authError.textContent = msg;
        authError.style.display = 'block';
        setTimeout(() => { authError.style.display = 'none'; }, 5000);
    }

    // Google sign-in
    btnGoogle.addEventListener('click', function () {
        var provider = new firebase.auth.GoogleAuthProvider();
        auth.signInWithPopup(provider).catch(function (err) {
            showError(err.message);
        });
    });

    // Email sign-in
    formEmail.addEventListener('submit', function (e) {
        e.preventDefault();
        var email = document.getElementById('auth-email').value;
        var password = document.getElementById('auth-password').value;
        auth.signInWithEmailAndPassword(email, password).catch(function (err) {
            showError(err.message);
        });
    });

    // Email register
    btnRegister.addEventListener('click', function () {
        var email = document.getElementById('auth-email').value;
        var password = document.getElementById('auth-password').value;
        if (!email || !password) {
            showError('Please enter email and password.');
            return;
        }
        if (password.length < 6) {
            showError('Password must be at least 6 characters.');
            return;
        }
        auth.createUserWithEmailAndPassword(email, password).catch(function (err) {
            showError(err.message);
        });
    });

    // Logout
    btnLogout.addEventListener('click', function () {
        auth.signOut();
    });

    // Auth state listener
    auth.onAuthStateChanged(function (user) {
        if (user) {
            // Hide login overlay
            overlay.classList.remove('active');

            // Show user info in sidebar
            var displayName = user.displayName || user.email.split('@')[0];
            userName.textContent = displayName;

            if (user.photoURL) {
                userAvatar.style.backgroundImage = 'url(' + user.photoURL + ')';
                userAvatar.textContent = '';
            } else {
                userAvatar.style.backgroundImage = '';
                userAvatar.textContent = displayName.charAt(0).toUpperCase();
            }
            userInfo.style.display = 'flex';

            // Store user doc for sharing lookups
            db.collection('users').doc(user.uid).set({
                email: user.email,
                displayName: displayName
            }, { merge: true });

            // Notify app.js
            window.dispatchEvent(new CustomEvent('auth-ready', {
                detail: { uid: user.uid, email: user.email, displayName: displayName }
            }));
        } else {
            // Show login overlay
            overlay.classList.add('active');
            userInfo.style.display = 'none';
        }
    });
})();
