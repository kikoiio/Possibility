export class SceneTimelineGuard {
  private current = ''
  setTimeline(id: string): void { this.current = id }
  accepts(id: string): boolean { return id.length > 0 && id === this.current }
}
