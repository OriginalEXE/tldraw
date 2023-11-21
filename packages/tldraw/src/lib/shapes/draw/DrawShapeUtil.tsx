/* eslint-disable react-hooks/rules-of-hooks */
import {
	Box2d,
	Circle2d,
	Edge2d,
	Polygon2d,
	Polyline2d,
	SVGContainer,
	ShapeUtil,
	SvgExportContext,
	TLDrawShape,
	TLDrawShapeSegment,
	TLOnResizeHandler,
	TLShapeUtilCanvasSvgDef,
	Vec2d,
	VecLike,
	canonicalizeRotation,
	drawShapeMigrations,
	drawShapeProps,
	getDefaultColorTheme,
	getSvgPathFromPoints,
	last,
	rng,
	shortAngleDist,
	toFixed,
} from '@tldraw/editor'
import { getShapeFillSvg } from '../shared/ShapeFill'
import { STROKE_SIZES } from '../shared/default-shape-constants'
import { getFillDefForCanvas, getFillDefForExport } from '../shared/defaultStyleDefs'
import { getStrokeOutlinePoints } from '../shared/freehand/getStrokeOutlinePoints'
import { getStrokePoints } from '../shared/freehand/getStrokePoints'
import { setStrokePointRadii } from '../shared/freehand/setStrokePointRadii'
import { getSvgPathFromStrokePoints } from '../shared/freehand/svg'
import { useForceSolid } from '../shared/useForceSolid'
import { getDrawShapeStrokeDashArray, getFreehandOptions, getPointsFromSegments } from './getPath'

type AugmentedPoint = {
	x: number
	y: number
	weight: number
	cornerAngle: number
	cornerSeverity: number
}
const distanceWindow = 3
const maxWeight = 0.5

function augmentPoints(points: VecLike[]): AugmentedPoint[] {
	if (points.length === 1) {
		return [
			{
				x: points[0].x,
				y: points[0].y,
				weight: maxWeight,
				cornerAngle: 0,
				cornerSeverity: 0,
			},
		]
	}
	const result: AugmentedPoint[] = new Array(points.length)
	const distances = new Array(points.length - 1)
	for (let i = 1; i < points.length; i++) {
		distances[i - 1] = Vec2d.Dist(points[i - 1], points[i])
	}

	for (let i = 0; i < points.length; i++) {
		let totalDistanceInWindow = 0
		let totalPointsInWindow = 0
		let avgWindowAngle = 0
		const windowStart = Math.max(0, i - distanceWindow)
		const windowEnd = Math.min(points.length - 1, windowStart + distanceWindow * 2 + 1)
		for (let j = windowStart; j <= windowEnd; j++) {
			totalDistanceInWindow += distances[j]
			totalPointsInWindow++
			if (j > windowStart) {
				avgWindowAngle += Vec2d.Angle(points[j - 1], points[j]) + Math.PI * 2
			}
		}
		avgWindowAngle /= totalPointsInWindow - 1
		avgWindowAngle = canonicalizeRotation(avgWindowAngle)
		const avgDistanceInWindow = totalDistanceInWindow / totalPointsInWindow
		let cornerAngle = 0
		let cornerSeverity = 0
		if (i === 0) {
			cornerAngle = Vec2d.Angle(points[0], points[1])
		} else if (i === points.length - 1) {
			cornerAngle = Vec2d.Angle(points[i - 1], points[i])
		} else {
			const windowLine = new Edge2d({
				start: Vec2d.From(points[windowStart]),
				end: Vec2d.From(points[windowEnd]),
			})
			const firstNeighborAngle = Vec2d.Angle(points[windowStart], points[i])
			if (shortAngleDist(avgWindowAngle, firstNeighborAngle) < 0) {
				cornerAngle = avgWindowAngle - Math.PI / 2
			} else {
				cornerAngle = avgWindowAngle + Math.PI / 2
			}
			cornerSeverity = Math.min(
				1,
				(10 * windowLine.distanceToPoint(Vec2d.From(points[i]))) / windowLine.length
			)
		}

		result[i] = {
			x: points[i].x,
			y: points[i].y,
			weight: Math.min(1 / avgDistanceInWindow, 0.5),
			cornerAngle,
			cornerSeverity,
		}
	}
	// soften corner severities

	// const severities = []
	// for (let i = 0; i < points.length; i++) {
	// 	const windowStart = Math.max(0, i - distanceWindow)
	// 	const windowEnd = Math.min(points.length - 1, windowStart + distanceWindow * 2 + 1)
	// 	let totalSeverity = 0
	// 	let totalNum = 0
	// 	for (let j = windowStart; j < windowEnd; j++) {
	// 		totalSeverity += result[j].cornerSeverity
	// 		totalNum++
	// 	}
	// 	severities[i] = totalSeverity / totalNum
	// }

	// for (let i = 0; i < points.length; i++) {
	// 	result[i].cornerSeverity = severities[i]
	// }

	return result
}

/** @public */
export class DrawShapeUtil extends ShapeUtil<TLDrawShape> {
	static override type = 'draw' as const
	static override props = drawShapeProps
	static override migrations = drawShapeMigrations

	override hideResizeHandles = (shape: TLDrawShape) => getIsDot(shape)
	override hideRotateHandle = (shape: TLDrawShape) => getIsDot(shape)
	override hideSelectionBoundsFg = (shape: TLDrawShape) => getIsDot(shape)

	override getDefaultProps(): TLDrawShape['props'] {
		return {
			segments: [],
			color: 'black',
			fill: 'none',
			dash: 'draw',
			size: 'm',
			isComplete: false,
			isClosed: false,
			isPen: false,
		}
	}

	getGeometry(shape: TLDrawShape) {
		const points = getPointsFromSegments(shape.props.segments)
		const strokeWidth = STROKE_SIZES[shape.props.size]

		// A dot
		if (shape.props.segments.length === 1) {
			const box = Box2d.FromPoints(points)
			if (box.width < strokeWidth * 2 && box.height < strokeWidth * 2) {
				return new Circle2d({
					x: -strokeWidth,
					y: -strokeWidth,
					radius: strokeWidth,
					isFilled: true,
				})
			}
		}

		const strokePoints = getStrokePoints(
			points,
			getFreehandOptions(shape.props, strokeWidth, true, true)
		).map((p) => p.point)

		// A closed draw stroke
		if (shape.props.isClosed) {
			return new Polygon2d({
				points: strokePoints,
				isFilled: shape.props.fill !== 'none',
			})
		}

		// An open draw stroke
		return new Polyline2d({
			points: strokePoints,
		})
	}

	component(shape: TLDrawShape) {
		const points = getPointsFromSegments(shape.props.segments)
		const [firstPoint, ...restPoints] = points
		let lineString = `M ${firstPoint.x} ${firstPoint.y} `
		for (const point of restPoints) {
			lineString += `L ${point.x} ${point.y} `
		}

		const augmentedPoints = augmentPoints(points)

		return (
			<SVGContainer id={shape.id}>
				<path d={lineString} strokeLinecap="round" fill="none" stroke={'black'} strokeWidth={'1'} />
				{augmentedPoints.map((point) => {
					return <circle cx={point.x} cy={point.y} r={3 + point.weight * 7} fill={'red'} />
				})}
				{augmentedPoints.map((point) => {
					return (
						<line
							x1={point.x}
							y1={point.y}
							x2={point.x + Math.cos(point.cornerAngle) * point.cornerSeverity * 10}
							y2={point.y + Math.sin(point.cornerAngle) * point.cornerSeverity * 10}
							stroke={'blue'}
							strokeWidth={0.6}
						/>
					)
				})}
			</SVGContainer>
		)
	}

	indicator(shape: TLDrawShape) {
		const forceSolid = useForceSolid()
		const strokeWidth = STROKE_SIZES[shape.props.size]
		const allPointsFromSegments = getPointsFromSegments(shape.props.segments)

		let sw = strokeWidth
		if (
			!forceSolid &&
			!shape.props.isPen &&
			shape.props.dash === 'draw' &&
			allPointsFromSegments.length === 1
		) {
			sw += rng(shape.id)() * (strokeWidth / 6)
		}

		const showAsComplete = shape.props.isComplete || last(shape.props.segments)?.type === 'straight'
		const options = getFreehandOptions(shape.props, sw, showAsComplete, true)
		const strokePoints = getStrokePoints(allPointsFromSegments, options)
		const solidStrokePath =
			strokePoints.length > 1
				? getSvgPathFromStrokePoints(strokePoints, shape.props.isClosed)
				: getDot(allPointsFromSegments[0], sw)

		return <path d={solidStrokePath} />
	}

	override toSvg(shape: TLDrawShape, ctx: SvgExportContext) {
		const theme = getDefaultColorTheme({ isDarkMode: this.editor.user.getIsDarkMode() })
		ctx.addExportDef(getFillDefForExport(shape.props.fill, theme))

		const { color } = shape.props

		const strokeWidth = STROKE_SIZES[shape.props.size]
		const allPointsFromSegments = getPointsFromSegments(shape.props.segments)

		const showAsComplete = shape.props.isComplete || last(shape.props.segments)?.type === 'straight'

		let sw = strokeWidth
		if (!shape.props.isPen && shape.props.dash === 'draw' && allPointsFromSegments.length === 1) {
			sw += rng(shape.id)() * (strokeWidth / 6)
		}

		const options = getFreehandOptions(shape.props, sw, showAsComplete, false)
		const strokePoints = getStrokePoints(allPointsFromSegments, options)
		const solidStrokePath =
			strokePoints.length > 1
				? getSvgPathFromStrokePoints(strokePoints, shape.props.isClosed)
				: getDot(allPointsFromSegments[0], sw)

		let foregroundPath: SVGPathElement | undefined

		if (shape.props.dash === 'draw' || strokePoints.length < 2) {
			setStrokePointRadii(strokePoints, options)
			const strokeOutlinePoints = getStrokeOutlinePoints(strokePoints, options)

			const p = document.createElementNS('http://www.w3.org/2000/svg', 'path')
			p.setAttribute('d', getSvgPathFromPoints(strokeOutlinePoints, true))
			p.setAttribute('fill', theme[color].solid)
			p.setAttribute('stroke-linecap', 'round')

			foregroundPath = p
		} else {
			const p = document.createElementNS('http://www.w3.org/2000/svg', 'path')
			p.setAttribute('d', solidStrokePath)
			p.setAttribute('stroke', theme[color].solid)
			p.setAttribute('fill', 'none')
			p.setAttribute('stroke-linecap', 'round')
			p.setAttribute('stroke-width', strokeWidth.toString())
			p.setAttribute('stroke-dasharray', getDrawShapeStrokeDashArray(shape, strokeWidth))
			p.setAttribute('stroke-dashoffset', '0')

			foregroundPath = p
		}

		const fillPath = getShapeFillSvg({
			fill: shape.props.isClosed ? shape.props.fill : 'none',
			d: solidStrokePath,
			color: shape.props.color,
			theme,
		})

		if (fillPath) {
			const g = document.createElementNS('http://www.w3.org/2000/svg', 'g')
			g.appendChild(fillPath)
			g.appendChild(foregroundPath)
			return g
		}

		return foregroundPath
	}

	override getCanvasSvgDefs(): TLShapeUtilCanvasSvgDef[] {
		return [getFillDefForCanvas()]
	}

	override onResize: TLOnResizeHandler<TLDrawShape> = (shape, info) => {
		const { scaleX, scaleY } = info

		const newSegments: TLDrawShapeSegment[] = []

		for (const segment of shape.props.segments) {
			newSegments.push({
				...segment,
				points: segment.points.map(({ x, y, z }) => {
					return {
						x: toFixed(scaleX * x),
						y: toFixed(scaleY * y),
						z,
					}
				}),
			})
		}

		return {
			props: {
				segments: newSegments,
			},
		}
	}

	override expandSelectionOutlinePx(shape: TLDrawShape): number {
		const multiplier = shape.props.dash === 'draw' ? 1.6 : 1
		return (STROKE_SIZES[shape.props.size] * multiplier) / 2
	}
}

function getDot(point: VecLike, sw: number) {
	const r = (sw + 1) * 0.5
	return `M ${point.x} ${point.y} m -${r}, 0 a ${r},${r} 0 1,0 ${r * 2},0 a ${r},${r} 0 1,0 -${
		r * 2
	},0`
}

function getIsDot(shape: TLDrawShape) {
	return shape.props.segments.length === 1 && shape.props.segments[0].points.length < 2
}
