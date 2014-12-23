import {DSLReader} from '../dsl-reader';
import {Tooltip} from '../api/balloon';
import {Emitter} from '../event';
import {SpecEngineFactory} from '../spec-engine-factory';
import {LayoutEngineFactory} from '../layout-engine-factory';
import {Plugins, propagateDatumEvents} from '../plugins';
import {utils} from '../utils/utils';
import {utilsDom} from '../utils/utils-dom';
import {CSS_PREFIX} from '../const';
import {UnitDomainMixin} from '../unit-domain-mixin';
import {UnitsRegistry} from '../units-registry';
import {DataProcessor} from '../data-processor';
import {getLayout} from '../utils/layuot-template';

var traverseFromDeep = (root) => {
    var r;

    if (!root.unit) {
        r = {w: 0, h: 0};
    }
    else {
        var s = traverseFromDeep(root.unit[0]);
        var g = root.guide;
        var xmd = g.x.$minimalDomain || 1;
        var ymd = g.y.$minimalDomain || 1;
        var maxW = Math.max((xmd * g.x.density), (xmd * s.w));
        var maxH = Math.max((ymd * g.y.density), (ymd * s.h));

        r = {
            w: maxW + g.padding.l + g.padding.r,
            h: maxH + g.padding.t + g.padding.b
        };
    }

    return r;
};

var traverseToDeep = (meta, root, size, localSettings) => {

    var mdx = root.guide.x.$minimalDomain || 1;
    var mdy = root.guide.y.$minimalDomain || 1;

    var perTickX = size.width / mdx;
    var perTickY = size.height / mdy;

    var dimX = meta.dimension(root.x);
    var dimY = meta.dimension(root.y);
    var xDensityPadding = localSettings.hasOwnProperty('xDensityPadding:' + dimX.dimType) ?
        localSettings['xDensityPadding:' + dimX.dimType] :
        localSettings.xDensityPadding;

    var yDensityPadding = localSettings.hasOwnProperty('yDensityPadding:' + dimY.dimType) ?
        localSettings['yDensityPadding:' + dimY.dimType] :
        localSettings.yDensityPadding;

    if (root.guide.x.hide !== true &&
        root.guide.x.rotate !== 0 &&
        (perTickX > (root.guide.x.$maxTickTextW + xDensityPadding * 2))) {

        root.guide.x.rotate = 0;
        root.guide.x.textAnchor = 'middle';
        root.guide.x.tickFormatWordWrapLimit = perTickX;
        var s = Math.min(localSettings.xAxisTickLabelLimit, root.guide.x.$maxTickTextW);

        var xDelta = 0 - s + root.guide.x.$maxTickTextH;

        root.guide.padding.b += (root.guide.padding.b > 0) ? xDelta : 0;

        if (root.guide.x.label.padding > (s + localSettings.xAxisPadding)) {
            root.guide.x.label.padding += xDelta;
        }
    }

    if (root.guide.y.hide !== true &&
        root.guide.y.rotate !== 0 &&
        (root.guide.y.tickFormatWordWrapLines === 1) &&
        (perTickY > (root.guide.y.$maxTickTextW + yDensityPadding * 2))) {

        root.guide.y.tickFormatWordWrapLimit = (perTickY - yDensityPadding * 2);
    }

    var newSize = {
        width: perTickX,
        height: perTickY
    };

    if (root.unit) {
        traverseToDeep(meta, root.unit[0], newSize, localSettings);
    }
};

export class Plot extends Emitter {
    constructor(config) {
        super();
        this._svg = null;
        this._filtersStore = {
            filters: {},
            tick: 0
        };
        this._layout = getLayout();
        this.setupConfig(config);
        //plugins
        this._plugins = new Plugins(this.config.plugins, this);
    }

    setupConfig(config) {
        this.config = _.defaults(config, {
            spec: {},
            data: [],
            plugins: [],
            settings: {}
        });
        this._emptyContainer = config.emptyContainer || '';
        // TODO: remove this particular config cases
        this.config.settings.specEngine = this.config.specEngine || this.config.settings.specEngine;
        this.config.settings.layoutEngine = this.config.layoutEngine || this.config.settings.layoutEngine;
        this.config.settings = this.setupSettings(this.config.settings);
        if (!utils.isArray(this.config.settings.specEngine)) {
            this.config.settings.specEngine = [
                {
                    width: Number.MAX_VALUE,
                    name: this.config.settings.specEngine
                }
            ];
        }

        this.config.spec.dimensions = this.setupMetaInfo(this.config.spec.dimensions, this.config.data);

        var log = this.config.settings.log;
        if (this.config.settings.excludeNull) {
            this.addFilter({
                tag: 'default',
                predicate: DataProcessor.excludeNullValues(this.config.spec.dimensions, function (item) {
                    log([item, 'point was excluded, because it has undefined values.'], 'WARN');
                })
            });
        }
    }

    getConfig() {
        return this.config;
    }

    setupMetaInfo(dims, data) {
        var meta = (dims) ? dims : DataProcessor.autoDetectDimTypes(data);
        return DataProcessor.autoAssignScales(meta);
    }

    setupSettings(configSettings) {
        var globalSettings = Plot.globalSettings;
        var localSettings = {};
        Object.keys(globalSettings).forEach((k) => {
            localSettings[k] = (_.isFunction(globalSettings[k])) ?
                globalSettings[k] :
                utils.clone(globalSettings[k]);
        });

        return _.defaults(configSettings || {}, localSettings);
    }

    insertToRightSidebar(el) {
        return utilsDom.appendTo(el, this._layout.rightSidebar);
    }


    addBalloon(conf) {
        return new Tooltip('', conf || {});
    }

    renderTo(target, xSize) {
        this._svg = null;
        this._defaultSize  = _.clone(xSize);
        var container = d3.select(target);
        var containerNode = container.node();
        this._target = target;
        this._targetSizes = xSize;
        if (containerNode === null) {
            throw new Error('Target element not found');
        }
        var content = this._layout.content;
        containerNode.appendChild(this._layout.layout);
        container = d3.select(this._layout.content);
        //todo don't compute width if width or height were passed
        var size = xSize || {};
        this._layout.content.innerHTML = '';
        if (!size.width || !size.height) {
            size = _.defaults(size, utilsDom.getContainerSize(this._layout.content.parentNode));
        }

        var drawData = this.getData();
        if (drawData.length === 0) {
            this._layout.content.innerHTML = this._emptyContainer;
            return;
        }
        this._targetSizes = size;
        this._layout.content.innerHTML = '';

        var domainMixin = new UnitDomainMixin(this.config.spec.dimensions, drawData);

        var specItem = _.find(this.config.settings.specEngine, (item) => (size.width <= item.width));

        var specEngine = SpecEngineFactory.get(specItem.name, this.config.settings);

        var fullSpec = specEngine(this.config.spec, domainMixin.mix({}));

        var optimalSize = traverseFromDeep(fullSpec.unit);
        var recommendedWidth = optimalSize.w;
        var recommendedHeight = optimalSize.h;

        var scrollSize = utilsDom.getScrollbarWidth();

        var deltaW = (size.width - recommendedWidth);
        var deltaH = (size.height - recommendedHeight);

        var screenW = (deltaW >= 0) ? size.width : recommendedWidth;
        var scrollW = (deltaH >= 0) ? 0 : scrollSize;

        var screenH = (deltaH >= 0) ? size.height : recommendedHeight;
        var scrollH = (deltaW >= 0) ? 0 : scrollSize;

        size.height = screenH - scrollH;
        size.width = screenW - scrollW;


        // optimize full spec depending on size
        var localSettings = this.config.settings;

        traverseToDeep(domainMixin.mix({}), fullSpec.unit, size, localSettings);


        var reader = new DSLReader(domainMixin, UnitsRegistry);

        var logicXGraph = reader.buildGraph(fullSpec);
        var layoutGraph = LayoutEngineFactory.get(this.config.settings.layoutEngine)(logicXGraph);
        var renderGraph = reader.calcLayout(layoutGraph, size);
        var svgXElement = reader.renderGraph(
            renderGraph,
            container
                .append("svg")
                .attr("class", CSS_PREFIX + 'svg')
                .attr("width", size.width)
                .attr("height", size.height),
            this
        );
        this._svg = svgXElement.node();
        svgXElement.selectAll('.i-role-datum').call(propagateDatumEvents(this));
        this._layout.rightSidebar.style.maxHeight = size.height + 'px';
        this.fire('render', this._svg);
    }

    getData(param) {
        param = param || {};
        var filters = _.chain(this._filtersStore.filters)
            .values()
            .flatten()
            .reject((filter)=>_.contains(param.excludeFilter, filter.tag))
            .pluck('predicate')
            .value();
        return _.filter(
            this.config.data,
            _.reduce(
                filters,
                (newPredicate, filter) => (x) => newPredicate(x) && filter(x),
                ()=>true
            )
        );
    }

    setData(data) {
        this.config.data = data;
        this.refresh();
    }
    getSVG() {
        return this._svg;
    }
    addFilter(filter) {
        var tag = filter.tag;
        var filters = this._filtersStore.filters[tag] = this._filtersStore.filters[tag] || [];
        var id = this._filtersStore.tick++;
        filter.id = id;
        filters.push(filter);
        this.refresh();
        return id;
    }

    refresh() {
        if(this._target) {
            this.renderTo(this._target,this._defaultSize);
        }
    }

    resize(sizes = {}) {
        this.renderTo(this._target, sizes);
    }
    removeFilter(id) {
        _.each(this._filtersStore.filters, (filters, key) => {
            this._filtersStore.filters[key] = _.reject(filters, (item) => item.id === id);
        });
        this.refresh();
    }
}
