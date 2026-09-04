(function() {
    'use strict';

    var emailOverlay = null;

    function init() {
        emailOverlay = document.querySelector('[data-ani="show-email-draft"]');

        bindShowEmailDraft();
        bindHideEmailDraft();
        bindBackdropClick();
        bindFooterButtons();
    }

    function bindShowEmailDraft() {
        var showBtns = document.querySelectorAll('[data-click="show-email-draft"]');
        for (var i = 0; i < showBtns.length; i++) {
            showBtns[i].addEventListener('click', function(e) {
                e.stopPropagation();
                if (emailOverlay) {
                    emailOverlay.style.display = 'flex';
                }
            });
        }
    }

    function bindHideEmailDraft() {
        var hideBtns = document.querySelectorAll('[data-click="hide-email-draft"]');
        for (var i = 0; i < hideBtns.length; i++) {
            hideBtns[i].addEventListener('click', function(e) {
                e.stopPropagation();
                hideOverlay();
            });
        }
    }

    function bindBackdropClick() {
        if (emailOverlay) {
            emailOverlay.addEventListener('click', function(e) {
                if (e.target === emailOverlay) {
                    hideOverlay();
                }
            });
        }
    }

    function bindFooterButtons() {
        var sendBtn = document.querySelector('.email-draft-send');
        var editBtn = document.querySelector('.email-draft-edit');

        if (sendBtn) {
            sendBtn.addEventListener('click', function(e) {
                e.stopPropagation();
                hideOverlay();
            });
        }

        if (editBtn) {
            editBtn.addEventListener('click', function(e) {
                e.stopPropagation();
                hideOverlay();
            });
        }
    }

    function hideOverlay() {
        if (emailOverlay) {
            emailOverlay.style.display = 'none';
        }
    }

    if (document.readyState === 'loading') {
        document.addEventListener('DOMContentLoaded', init);
    } else {
        init();
    }
})();
