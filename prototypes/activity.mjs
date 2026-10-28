const amount = value => Number.isFinite(value) ? String(Math.round(value * 1000) / 1000) : '未知';

// Every entry is projected from a committed revision or a saved failed attempt.
// Model previews, intentions and wall-clock elapsed time never become events.
export function projectActivity(snapshot, ledgers = {}) {
  const history = snapshot.history ?? [];
  const activity = [];
  for (const entry of history) {
    const { event, world, revision, worldMinute: minute } = entry;
    const actor = world.actors?.find(a => a.id === event.actorId);
    const name = actor?.name ?? '人物';
    const place = id => world.places?.find(p => p.id === id)?.name ?? id;
    const resourceChange = change => {
      const resource = world.resources?.find(r => r.id === change.resourceId);
      return `${resource?.name ?? change.resourceId} ${amount(change.before)} → ${amount(change.after)}${resource?.unit ?? ''}`;
    };
    let text = '', detail = '', kind = 'action';
    switch (event.type) {
      case 'origin': text = `${world.title ?? '世界'}从这里开始。`; detail = world.description ?? ''; kind = 'origin'; break;
      case 'speak': text = `${name}：“${event.text}”`; detail = `${place(actor?.location)} · ${event.effects?.statement?.listeners?.length ? '在场的人听见了这句话' : '没有其他人在场'}`; kind = 'speech'; break;
      case 'moveTo': text = `${name}来到${place(event.location)}。`; break;
      case 'inspect': {
        const clue = world.story?.clues.find(c => c.id === event.clueId);
        text = `${name}检查了${clue?.name ?? '眼前的线索'}。`; detail = '发现的内容进入了本人的观察与经历。'; break;
      }
      case 'perform': {
        const action = world.actions?.find(a => a.id === event.actionId);
        text = `${name}${action?.name ?? '完成了一次行动'}。`;
        detail = (event.effects?.resources ?? []).map(resourceChange).join('；'); break;
      }
      case 'rest': text = `${name}在${place(actor?.location)}休息。`; detail = `疲劳降至 ${amount(actor?.fatigue)}`; break;
      case 'observe': text = `${name}留在${place(actor?.location)}观察周围。`; break;
      case 'continuous_step': {
        const changes = (event.settlements ?? []).filter(s => s.appliedDelta !== 0);
        if (!changes.length) continue;
        text = changes.map(resourceChange).join('；'); kind = 'environment';
        const ids = new Set(changes.map(c => c.resourceId));
        const activeIds = event.processes ? new Set(event.processes.filter(p => p.active).map(p => p.id)) : null;
        detail = (world.processes ?? []).filter(p => ids.has(p.resourceId) && (!activeIds || activeIds.has(p.id))).map(p => p.description).join('；');
        break;
      }
      default: text = event.result?.message ?? ''; break;
    }
    if (text) activity.push({ id: `${snapshot.instanceId}:revision:${revision}`, revision, minute, kind, actorId: event.actorId ?? null, text, detail });
  }
  for (const ledger of Object.values(ledgers)) {
    for (const entry of ledger.entries ?? []) {
      if (entry.outcome?.ok !== false || entry.source?.instanceId !== snapshot.instanceId) continue;
      activity.push({ id: `${snapshot.instanceId}:attempt:${entry.id}`, revision: entry.source.toRevision - 0.5,
        minute: entry.source.fromMinute, kind: 'failure', actorId: entry.actorId,
        text: `${entry.observation?.name ?? '人物'}的尝试未能完成。`, detail: entry.outcome.message ?? entry.outcome.reason ?? '没有产生行动效果。' });
    }
  }
  return activity.sort((a, b) => a.revision - b.revision).slice(-120);
}
