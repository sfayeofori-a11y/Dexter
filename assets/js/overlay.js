function checkScroll() {
  const scrollLock = document.querySelector('[data-scroll-disable="yes"]');
  const whenVisible = document.querySelector('[data-scroll-disable="when-visible"]');
  if (!scrollLock || !whenVisible) return;
  const visible = getComputedStyle(whenVisible).display !== "none";
  scrollLock.classList.toggle("no-scroll", visible);
}

window.addEventListener("load", checkScroll);
document.addEventListener("click", checkScroll);

document.querySelectorAll('[data-click="show-add"]').forEach((item) => {
  item.addEventListener("click", () => {
    document.querySelector('[data-ani="show-add"]').style.display = "flex";
  });
});

document.querySelectorAll('[data-click="hide-add"]').forEach((item) => {
  item.addEventListener("click", (e) => {
    if (e.target === item) {
      document.querySelector('[data-ani="show-add"]').style.display = "none";
    }
  });
});
