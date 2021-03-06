/*---------------------------------------------------------------------------------------------
* Copyright (c) Bentley Systems, Incorporated. All rights reserved.
* See LICENSE.md in the project root for license terms and full copyright notice.
*--------------------------------------------------------------------------------------------*/
import { assert, compareStrings, Id64 } from "@bentley/bentleyjs-core";
import { Point3d, Range3d } from "@bentley/geometry-core";
import { Placement3d, RelatedElement, SectionLocationProps, ViewAttachmentProps, ViewFlagOverrides } from "@bentley/imodeljs-common";
import {
  FeatureSymbology, GeometricModel2dState, HitDetail, IModelConnection, RenderSystem, Tile, TileContent, TiledGraphicsProvider, TileDrawArgs,
  TileLoadPriority, TileRequest, TileTree, TileTreeOwner, TileTreeReference, TileTreeSet, TileTreeSupplier, Viewport, ViewState, ViewState2d,
} from "@bentley/imodeljs-frontend";

class ProxyTreeSupplier implements TileTreeSupplier {
  public compareTileTreeIds(lhs: SectionLocationProps, rhs: SectionLocationProps): number {
    return compareStrings(lhs.id!, rhs.id!);
  }

  public async createTileTree(props: SectionLocationProps, iModel: IModelConnection): Promise<TileTree | undefined> {
    const view = await this.getViewState(props, iModel);
    if (undefined === view || !view.is2d())
      return undefined;

    await iModel.models.load(view.baseModelId);
    const model = iModel.models.getLoaded(view.baseModelId);
    if (undefined === model || !(model instanceof GeometricModel2dState))
      return undefined;

    const treeRef = model.createTileTreeReference(view);
    const tree = await treeRef.treeOwner.loadTree();
    if (undefined === tree)
      return undefined;

    return new ProxyTree(tree, treeRef, view, props);
  }

  private async getViewState(props: SectionLocationProps, iModel: IModelConnection): Promise<ViewState | undefined> {
    if (undefined === props.viewAttachment)
      return undefined;

    const attachmentId = RelatedElement.idFromJson(props.viewAttachment);
    if (Id64.isInvalid(attachmentId))
      return undefined;

    const attachments = await iModel.elements.getProps(attachmentId) as ViewAttachmentProps[];
    if (1 === attachments.length)
      return iModel.views.load(attachments[0].view.id);

    return undefined;
  }
}

const proxyTreeSupplier = new ProxyTreeSupplier();

/** A proxy for a 2d tile tree to be drawn in the context of a spatial view. */
class ProxyTreeReference extends TileTreeReference {
  private readonly _owner: TileTreeOwner;

  public constructor(props: SectionLocationProps, iModel: IModelConnection) {
    super();
    this._owner = iModel.tiles.getTileTreeOwner(props, proxyTreeSupplier);
  }

  public get castsShadows() {
    return false;
  }

  public get treeOwner() { return this._owner; }

  private get _proxiedRef(): TileTreeReference | undefined {
    const proxiedTree = this.treeOwner.tileTree as ProxyTree;
    return undefined !== proxiedTree ? proxiedTree.ref : undefined;
  }

  public discloseTileTrees(trees: TileTreeSet): void {
    super.discloseTileTrees(trees);
    const ref = this._proxiedRef;
    if (undefined !== ref)
      ref.discloseTileTrees(trees);
  }

  public getToolTip(hit: HitDetail) {
    const ref = this._proxiedRef;
    return undefined !== ref ? ref.getToolTip(hit) : super.getToolTip(hit);
  }
}

/** A proxy for a 2d tile tree to be drawn in the context of a spatial view. */
class ProxyTree extends TileTree {
  private readonly _rootTile: ProxyTile;
  private readonly _viewFlagOverrides: ViewFlagOverrides;
  public readonly tree: TileTree;
  public readonly ref: TileTreeReference;
  public readonly symbologyOverrides: FeatureSymbology.Overrides;

  public constructor(tree: TileTree, ref: TileTreeReference, view: ViewState2d, props: SectionLocationProps) {
    const placement = Placement3d.fromJSON(props.placement);
    const location = placement.transform;
    const inverseLocation = location.inverse();
    if (undefined === inverseLocation) {
      location.origin.set(0, 0, placement.origin.z);
    } else {
      const origin = inverseLocation.multiplyPoint3d(Point3d.createZero());
      origin.z = 0;
      location.multiplyPoint3d(origin, origin);
      location.origin.setFrom(origin);
    }

    super({
      id: tree.modelId + "_hypermodeling",
      modelId: tree.modelId,
      iModel: tree.iModel,
      location,
      priority: TileLoadPriority.Primary,
    });

    this.tree = tree;
    this.ref = ref;
    this.symbologyOverrides = new FeatureSymbology.Overrides(view);

    const range = tree.iModelTransform.multiplyRange(tree.rootTile.range);
    const inverse = location.inverse();
    if (undefined !== inverse)
      inverse.multiplyRange(range, range);

    this._viewFlagOverrides = new ViewFlagOverrides(view.viewFlags);
    this._viewFlagOverrides.setApplyLighting(false);
    this._viewFlagOverrides.setShowClipVolume(false);

    this._rootTile = new ProxyTile(this, range);
  }

  public get rootTile(): ProxyTile { return this._rootTile; }
  public get viewFlagOverrides() { return this._viewFlagOverrides; }
  public get is3d() { return false; }
  public get isContentUnbounded() { return false; }
  public get maxDepth() { return 1; }

  public draw(args: TileDrawArgs): void {
    const tiles = this.selectTiles(args);
    for (const tile of tiles)
      tile.drawGraphics(args);

    args.drawGraphics();
  }

  protected _selectTiles(_args: TileDrawArgs): Tile[] {
    return [this.rootTile];
  }

  public prune(): void {
    // Our single tile is only a proxy. Our proxied tree(s) will be pruned separately
  }
}

/** The single Tile belonging to a ProxyTree, serving as a proxy for all of the proxied tree's tiles. */
class ProxyTile extends Tile {
  public constructor(tree: ProxyTree, range: Range3d) {
    super({ contentId: "", range, maximumSize: 512, isLeaf: true }, tree);
    this.setIsReady();
  }

  public get hasChildren() { return false; }
  public get hasGraphics() { return true; }

  public async requestContent(_isCanceled: () => boolean): Promise<TileRequest.Response> { return undefined; }
  public async readContent(_data: TileRequest.ResponseData, _system: RenderSystem, _isCanceled?: () => boolean): Promise<TileContent> { return {}; }
  protected _loadChildren(_resolve: (children: Tile[]) => void, _reject: (error: Error) => void): void { }

  public drawGraphics(args: TileDrawArgs) {
    const myTree = this.tree as ProxyTree;
    const sectionTree = myTree.tree;

    const location = myTree.iModelTransform.multiplyTransformTransform(sectionTree.iModelTransform);
    const drawArgs = TileDrawArgs.fromTileTree(args.context, location, sectionTree, myTree.viewFlagOverrides, sectionTree.clipVolume, args.parentsAndChildrenExclusive, myTree.symbologyOverrides);
    sectionTree.draw(drawArgs);
  }
}

/** Draws the 2d section graphics into the 3d view. */
class SectionGraphicsProvider implements TiledGraphicsProvider {
  private readonly _treeRef: TileTreeReference;

  public constructor(ref: ProxyTreeReference) {
    this._treeRef = ref;
  }

  public forEachTileTreeRef(_viewport: Viewport, func: (ref: TileTreeReference) => void): void {
    func(this._treeRef);
  }
}

export async function createSectionGraphicsProvider(sectionLocationProps: SectionLocationProps, iModel: IModelConnection): Promise<TiledGraphicsProvider> {
  assert(undefined !== sectionLocationProps.id);
  const ref = new ProxyTreeReference(sectionLocationProps, iModel);
  return new SectionGraphicsProvider(ref);
}
