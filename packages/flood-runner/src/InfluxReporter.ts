import { IPoint } from '@flood/node-influx/lib/src/index'
import { serializePoint } from '@flood/node-influx/lib/src/line-protocol'
import { Socket, createSocket } from 'dgram'
import * as zlib from 'zlib'
import MetricIdentifier from './MetricIdentifier'
import { assertConfigString } from './ConfigUtils'
import { numberOfBrowsers } from './ConcurrencyHack'

import {
	IReporter,
	MeasurementKind,
	TraceData,
	TestEvent,
	CompoundMeasurement,
	TestScriptError,
	expect,
} from '@flood/element-report'

import debugFactory from 'debug'
const debug = debugFactory('element:grid:influx')

export interface InfluxReporterOptions {
	influxHost: string
	influxPort: number
	metricIdentifier: MetricIdentifier
}

type MeasurementData = {
	value: string | number | CompoundMeasurement
	label: string
}

type Measurements = { [key in MeasurementKind]?: MeasurementData[] }

// a version of IPoint with everything but timestamp required
export interface ConcretePoint {
	measurement: string
	tags: { [name: string]: string }
	fields: { [name: string]: any }

	timestamp?: Date | string | number
}

export function encodeTraceData(traceData: TraceData) {
	const compressedData = zlib.gzipSync(new Buffer(JSON.stringify(traceData), 'utf8'))
	return compressedData.toString('base64')
}

export function decodeTraceData(traceData: string) {
	return JSON.parse(zlib.unzipSync(new Buffer(traceData, 'base64')).toString('utf8'))
}

export default class InfluxReporter implements IReporter {
	public responseCode = '200'
	public stepName: string

	private socket: Socket
	private measurements: Measurements = {}

	constructor(private options: InfluxReporterOptions) {
		this.createSocket()
	}

	validateConfig(): InfluxReporter | never {
		assertConfigString(this.options.influxHost, 'influx host not set')

		const { influxPort } = this.options

		if (influxPort === 0 || influxPort > 65535) {
			throw new Error('influxPort (value: ${influxPort}) invalid')
		}

		return this
	}

	private createSocket() {
		this.socket = createSocket('udp4')
	}

	private newPoint(measurement: string, label: string): ConcretePoint {
		const point = {
			measurement,
			tags: { ...this.options.metricIdentifier.influxTags },
			fields: { ['response_code']: this.responseCode },
		}

		if (label !== undefined) {
			point.tags.label = encodeURIComponent(label)
		}

		return point
	}

	private async send(point: IPoint) {
		const payload = serializePoint(point)
		debug(payload)

		const message = Buffer.from(payload)

		await new Promise((yeah, _nah) => {
			this.socket.send(
				message,
				Number(this.options.influxPort),
				this.options.influxHost,
				(err: Error, bytes: number) => {
					if (err) {
						console.error(`REPORTER.socket.send() ERROR: ${err.message}`)
					} else {
						console.debug(
							`REPORTER.socket.send() wrote ${bytes} bytes to ${this.options.influxHost}:${this.options.influxPort}`
						)
						console.debug(message.toString())
					}
					yeah(true)
				}
			)
		})
	}

	close() {
		return this.socket.close()
	}

	reset(stepName = ''): void {
		this.stepName = stepName
		this.responseCode = '200'
		this.measurements = {}
	}

	addTrace(traceData: TraceData, label: string): void {
		if (!traceData.objects) traceData.objects = []
		const base64EncodedData = encodeTraceData(traceData)
		this.addMeasurement('object', base64EncodedData, label)
	}

	private pushMeasurement(
		measurement: string,
		value: string | number | CompoundMeasurement,
		label: string
	) {
		const measurements = this.measurements[measurement] || (this.measurements[measurement] = [])
		measurements.push({ value, label })
	}

	addMeasurement(measurement: MeasurementKind, value: string | number, label?: string): void {
		label = expect(
			label || this.stepName,
			`Label must be present when writing measurement: ${measurement}`
		)

		this.pushMeasurement(measurement, value, label)
	}

	addCompoundMeasurement(
		measurement: MeasurementKind,
		value: CompoundMeasurement,
		label: string
	): void {
		label = expect(
			label || this.stepName,
			`Label must be present when writing compound measurement: ${measurement}`
		)

		this.pushMeasurement(measurement, value, label)
	}

	async flushMeasurements(): Promise<void> {
		const sends: Promise<void>[] = []
		const printedResults: string[] = []

		for (const [measurement, values] of Object.entries(this.measurements)) {
			if (values === undefined) continue
			// concurrency is handled independently of the Test
			if (measurement === 'concurrency') {
				continue
			}

			if (!['trace', 'object'].includes(measurement)) {
				printedResults.push(
					`${measurement}: [${values.map((m) => JSON.stringify(m.value)).join(', ')}]`
				)
			}

			values.forEach((reading) => {
				const point = this.newPoint(measurement, reading.label)

				const { value } = reading

				if (typeof value === 'string' || typeof value === 'number') {
					point.fields['value'] = value
				} else {
					Object.entries(value)
						.filter(([_, value]) => value !== undefined)
						.forEach(([key, value]) => (point.fields[key] = value))
				}

				sends.push(this.send(point))
			})
		}

		await Promise.all(sends)
	}

	async sendConcurrencyPoint(): Promise<void> {
		const point = this.newPoint('concurrency', this.stepName)
		delete point.tags['label']
		point.fields['response_code'] = '0'
		point.fields['value'] = numberOfBrowsers()
		return this.send(point)
	}

	testLifecycle(stage: TestEvent, label: string): void {
		switch (stage) {
			case TestEvent.AfterStepAction:
				console.info(`---> ${label}()`)
				break
			case TestEvent.BeforeStep:
				console.info(`===> Step '${label}'`)
				break
			case TestEvent.AfterStep:
				console.info(`---> Step '${label}' finished`)
				break
			case TestEvent.StepSkipped:
				console.info(`---- Step '${label}'`)
				break
		}
	}

	// TODO should we add more detail here?
	testScriptError(message: string, error: TestScriptError): void {
		console.error(`=!=> ${message} in ${this.stepName}: ${error.name}: ${error.message}`)
		error.unmappedStack.forEach((line) => console.error(`    ${line}`))
	}

	testStepError(error: TestScriptError): void {
		this.testScriptError('Failure', error)
	}

	testInternalError(message: string, error: Error): void {
		console.error(`=!=> Internal ${message} error in ${this.stepName}`, error.message)
	}

	testAssertionError(error: TestScriptError): void {
		this.testScriptError('Assertion failure', error)
	}

	testScriptConsole(method: string, message?: any, ...optionalParams: any[]): void {
		const c = (console as any)[method] || console.log
		c(message, ...optionalParams)
	}
}
