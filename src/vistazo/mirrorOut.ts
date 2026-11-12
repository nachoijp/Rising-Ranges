import OBR, { type Image, type InteractionManager, type Item, type Vector2 } from "@owlbear-rodeo/sdk";
import { MirrorSender } from "../background/mirrorSend";
import { buildOriginAnchor, originShapeKey } from "../render/bandRings";
import { computeLecturaState, type LecturaOrigin } from "../render/computeLectura";
import { sameLecturaState, type LecturaContext, type LecturaState } from "../render/lecturaItems";

// A Vistazo's drag or free point on the maps too (every client's, this one's as well), as the map's
// own Medición shows on the others' (see background/measureMirror.ts): its rings, its Lecturas on the
// tokens and its height, sent as that one's are. The Vistazos have it from the Vistazo already (see
// remote.ts), so they leave it out.
//
// Owlbear stops syncing an interaction to other clients 15 s after it starts (undocumented): the rings
// ride on one (the Origen's anchor), so it's ended for everyone then, as the map's is (see
// createMeasureTool.ts). A free point moved or raised after that is shown again.

const REMOTE_SYNC_CUTOFF_MS = 14900;
/** Its sessions' numbers, apart from the map's (both send on this client's connection). */
const FIRST_SESSION = 1_000_000_000;

/** What's measured, as it is now. */
export type Measure = {
  /** Which it is (a token's drag, the free point): another, and it's a new Medición. */
  key: string;
  /** Where the rings are (a dragged token's: where it started, as on the map). */
  center: Vector2;
  /** The Origen token's radius (grid units), 0 from a point. */
  radius: number;
  originTokenId?: string;
  /** What the Lecturas measure from: the dragged token where it is now, its height over the ground included. */
  from: LecturaOrigin;
  /** The height label's text; null: heights off. */
  heightText: string | null;
  ctx: LecturaContext;
  /** The tokens read (none hidden: everyone gets these), where they are and how high (the ground included). */
  tokens: { token: Image; position: Vector2; height: number }[];
};

type Session = {
  key: string;
  center: Vector2;
  /** Its anchor's interaction (null until Owlbear's begun it); ended (Owlbear's 15 s are up, or it failed). */
  interaction: InteractionManager<Item[]> | null;
  over: boolean;
  cutoff: ReturnType<typeof setTimeout> | null;
  states: Map<string, LecturaState>;
  heightText: string | null;
  shape: string | null;
  /** What's to be sent once it's begun (moves meanwhile). */
  latest: Measure;
};

export class MirrorOut {
  private readonly sender = new MirrorSender("ALL", FIRST_SESSION, true);
  private session: Session | null = null;

  /** What's measured now (null: nothing): the maps told what changed. */
  show(measure: Measure | null) {
    const session = this.session;
    if (!measure) {
      this.end();
      return;
    }
    if (session && session.key === measure.key) {
      const moved = Math.hypot(measure.center.x - session.center.x, measure.center.y - session.center.y) > 0.5;
      // A free point's 15 s up, and it's moved or raised since: shown again (a token's drag isn't, till the next).
      if (session.over && !measure.originTokenId) {
        this.end();
        this.begin(measure);
        return;
      }
      session.latest = measure;
      if (!session.over && session.interaction) {
        this.follow(session, measure, moved);
      }
      return;
    }
    this.end();
    this.begin(measure);
  }

  private states(measure: Measure): Map<string, LecturaState> {
    const { bandSet, dpi, axonometry, display, showDistance } = measure.ctx;
    const lecturas = !!display && (display.lecturaStyle !== "none" || display.lecturaLabel !== "none");
    const states = new Map<string, LecturaState>();
    if (lecturas) {
      for (const { token, position, height } of measure.tokens) {
        states.set(token.id, computeLecturaState(token, position, height, measure.from, { bandSet, dpi, axonometry: axonometry ?? 0, display, showDistance: showDistance ?? false }));
      }
    }
    return states;
  }

  private begin(measure: Measure) {
    const anchor = buildOriginAnchor(measure.center);
    const session: Session = {
      key: measure.key,
      center: measure.center,
      interaction: null,
      over: false,
      cutoff: null,
      states: new Map(),
      heightText: measure.heightText,
      shape: originShapeKey(measure.center, measure.ctx.dpi, measure.ctx.bandSet),
      latest: measure,
    };
    this.session = session;
    OBR.interaction.startItemInteraction([anchor]).then(
      (interaction) => {
        if (this.session !== session) {
          interaction[1]();
          return;
        }
        session.interaction = interaction;
        // Only now: the others attach what they draw to the anchor, so it has to be there for them first.
        const latest = session.latest;
        session.states = this.states(latest);
        session.heightText = latest.heightText;
        this.sender.start({
          ctx: latest.ctx,
          states: Object.fromEntries(session.states),
          shaders: [],
          ringId: anchor.id,
          originTokenId: latest.originTokenId,
          heightLabel: latest.heightText === null ? null : { center: session.center, text: latest.heightText },
          origin: { center: session.center, radius: latest.radius },
        });
        // Moved while it began: there now.
        if (Math.hypot(latest.center.x - session.center.x, latest.center.y - session.center.y) > 0.5) {
          this.follow(session, latest, true);
        }
        session.cutoff = setTimeout(() => {
          session.cutoff = null;
          this.stop(session);
        }, REMOTE_SYNC_CUTOFF_MS);
      },
      (error) => {
        console.error("Rising Ranges: failed to show the Vistazo's Medición on the map", error);
        session.over = true;
      }
    );
  }

  /** Its Lecturas, height and (moved) its rings, as they are now. */
  private follow(session: Session, measure: Measure, moved: boolean) {
    if (moved && session.interaction) {
      session.center = measure.center;
      const center = measure.center;
      session.interaction[0]((anchors) => {
        for (const anchor of anchors) {
          anchor.position = center;
        }
      });
      // From a cell's center to a corner or back (a hex grid): the rings change shape.
      const shape = originShapeKey(center, measure.ctx.dpi, measure.ctx.bandSet);
      if (shape !== session.shape) {
        session.shape = shape;
        this.sender.reshape(center);
      }
    }
    const states = this.states(measure);
    const changed: Record<string, LecturaState> = {};
    let any = false;
    for (const [id, state] of states) {
      if (!sameLecturaState(session.states.get(id), state)) {
        session.states.set(id, state);
        changed[id] = state;
        any = true;
      }
    }
    if (any) {
      this.sender.states(changed);
    }
    if (measure.heightText !== null && measure.heightText !== session.heightText) {
      session.heightText = measure.heightText;
      this.sender.heightText(measure.heightText);
    }
  }

  /** Ended for everyone (its anchor let go), the session kept to know what it was. */
  private stop(session: Session) {
    if (session.over) {
      return;
    }
    session.over = true;
    if (session.cutoff) {
      clearTimeout(session.cutoff);
      session.cutoff = null;
    }
    if (session.interaction) {
      this.sender.end();
      session.interaction[1]();
    }
  }

  /** Nothing measured: ended for everyone. */
  end() {
    if (this.session) {
      this.stop(this.session);
      this.session = null;
    }
  }
}
