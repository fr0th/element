import { serve } from '../../../tests/support/fixture-server'
import { launchPlaywright, testPlaywright } from '../../../tests/support/launch-browser'
import { Page } from 'playwright'
import { Until } from '../Until'

let page: Page, playwright: testPlaywright

describe('Condition', () => {
	jest.setTimeout(30e3)
	describe('TitleCondition', () => {
		beforeAll(async () => {
			playwright = await launchPlaywright()
			page = playwright.page
		})

		afterAll(async () => {
			await playwright.close()
		})

		beforeEach(async () => {
			const url = await serve('wait.html')
			await page.goto(url)
		})

		test('waits Until.titleIs', async () => {
			const condition = Until.titleIs('another title')

			await page.evaluate(() => {
				return new Promise((yeah) => {
					setTimeout(() => {
						document.title = 'another title'
						yeah(true)
					}, 100)
				})
			})

			const result = await condition.waitFor(page.mainFrame())
			expect(result).toBe(true)
		})

		test('waits Until.titleContains', async () => {
			const condition = Until.titleContains('another title')

			await page.evaluate(() => {
				return new Promise((yeah) => {
					setTimeout(() => {
						document.title = 'another title again'
						yeah(true)
					}, 100)
				})
			})

			const result = await condition.waitFor(page.mainFrame())
			expect(result).toBe(true)
		})

		test('waits Until.titleMatches', async () => {
			const condition = Until.titleMatches(/^another/)

			await page.evaluate(() => {
				return new Promise((yeah) => {
					setTimeout(() => {
						document.title = 'another title again'
						yeah(true)
					}, 100)
				})
			})

			const result = await condition.waitFor(page.mainFrame())
			expect(result).toBe(true)
		})
	})
})
