const buttons = [...document.querySelectorAll('.nav-button')];
const views = [...document.querySelectorAll('.view')];

function showView(id) {
  views.forEach((view) => view.classList.toggle('active', view.id === id));
  buttons.forEach((button) => {
    const active = button.dataset.view === id;
    button.classList.toggle('active', active);
    if (active) button.setAttribute('aria-current', 'page');
    else button.removeAttribute('aria-current');
  });
  history.replaceState(null, '', `#${id}`);
  window.scrollTo({ top: 0, behavior: 'smooth' });
}

buttons.forEach((button) => button.addEventListener('click', () => showView(button.dataset.view)));
document.querySelectorAll('[data-jump]').forEach((button) => button.addEventListener('click', () => showView(button.dataset.jump)));

const requested = location.hash.slice(1);
if (views.some((view) => view.id === requested)) showView(requested);

const clock = document.querySelector('#clock');
function updateClock() {
  clock.textContent = `${new Intl.DateTimeFormat('en-US', { hour: 'numeric', minute: '2-digit', second: '2-digit', timeZoneName: 'short' }).format(new Date())} · preview`;
}
updateClock();
setInterval(updateClock, 1000);
