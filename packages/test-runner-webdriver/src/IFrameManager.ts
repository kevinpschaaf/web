import { TestRunnerCoreConfig } from '@web/test-runner-core';
import { BrowserObject, Element } from 'webdriverio';
import { validateBrowserResult } from './coverage';

/**
 * Manages tests to be executed in iframes on a page.
 */
export class IFrameManager {
  private config: TestRunnerCoreConfig;
  private driver: BrowserObject;
  private framePerSession = new Map<string, string>();
  private inactiveFrames: string[] = [];
  private frameCount = 0;
  private initialized = false;
  private initializePromise?: Promise<void>;
  private locked?: Promise<unknown>;
  private isIE: boolean;

  constructor(config: TestRunnerCoreConfig, driver: BrowserObject, isIE: boolean) {
    this.config = config;
    this.driver = driver;
    this.isIE = isIE;
  }

  private async _initialize(url: string) {
    const pageUrl = `${new URL(url).origin}/?mode=iframe`;
    await this.driver.navigateTo(pageUrl);
  }

  isActive(id: string) {
    return this.framePerSession.has(id);
  }

  async getBrowserUrl(sessionId: string): Promise<string | undefined> {
    const frameId = this.getFrameId(sessionId);

    const returnValue = (await this.driver.execute(`
      try {
        var iframe = document.getElementById("${frameId}");
        return iframe.contentWindow.location.href;
      } catch (_) {
        return undefined;
      }
    `)) as string | undefined;

    return returnValue;
  }

  private getFrameId(sessionId: string): string {
    const frameId = this.framePerSession.get(sessionId);
    if (!frameId) {
      throw new Error(
        `Something went wrong while running tests, there is no frame id for session ${sessionId}`,
      );
    }
    return frameId;
  }

  private async scheduleCommand<T>(fn: () => Promise<T>) {
    if (!this.isIE) {
      return fn();
    }

    while (this.locked) {
      await this.locked;
    }

    const fnPromise = fn();
    this.locked = fnPromise;
    const result = await fnPromise;
    this.locked = undefined;
    return result;
  }

  async queueStartSession(id: string, url: string) {
    if (!this.initializePromise && !this.initialized) {
      this.initializePromise = this._initialize(url);
    }

    if (this.initializePromise) {
      await this.initializePromise;
      this.initializePromise = undefined;
      this.initialized = true;
    }

    this.scheduleCommand(() => this.startSession(id, url));
  }

  private async startSession(id: string, url: string) {
    let frameId: string;
    if (this.inactiveFrames.length > 0) {
      frameId = this.inactiveFrames.pop()!;
      await this.driver.execute(`
        var iframe = document.getElementById("${frameId}");
        iframe.src = "${url}";
      `);
    } else {
      this.frameCount += 1;
      frameId = `wtr-test-frame-${this.frameCount}`;
      await this.driver.execute(`
        var iframe = document.createElement("iframe");
        iframe.id = "${frameId}";
        iframe.src = "${url}";
        document.body.appendChild(iframe);
      `);
    }

    this.framePerSession.set(id, frameId);
  }

  async queueStopSession(id: string) {
    return this.scheduleCommand(() => this.stopSession(id));
  }

  async stopSession(id: string) {
    const frameId = this.getFrameId(id);

    // Retrieve test results from iframe. Note: IIFE is used to prevent
    // WebdriverIO from crashing failure with Puppeteer (default mode):
    // Error: Evaluation failed: SyntaxError: Illegal return statement
    // See https://github.com/webdriverio/webdriverio/pull/4829
    const returnValue = await this.driver.execute(`
      return (function() {
        var iframe = document.getElementById("${frameId}");
        var testCoverage;
        try {
          testCoverage = iframe.contentWindow.__coverage__;
        } catch (error) {
          // iframe can throw a cross-origin error if the test navigated
        }

        // set src after retrieving values to avoid the iframe from navigating away
        iframe.src = "data:,";
        return { testCoverage: testCoverage };
      })();
    `);

    if (!validateBrowserResult(returnValue)) {
      throw new Error();
    }

    const { testCoverage } = returnValue;

    this.inactiveFrames.push(frameId);

    return { testCoverage: this.config.coverage ? testCoverage : undefined };
  }

  async takeScreenshot(sessionId: string, locator: string): Promise<Buffer> {
    const frameId = this.getFrameId(sessionId);

    const frame = await this.driver.$(`iframe#${frameId}`);

    await this.driver.switchToFrame(frame);

    const elementData = (await this.driver.execute(locator, [])) as Element;

    const element = await this.driver.$(elementData);

    let base64 = '';

    try {
      base64 = await this.driver.takeElementScreenshot(element.elementId);
    } catch (err) {
      console.log('Failed to take a screenshot:', err);
    }

    await this.driver.switchToParentFrame();

    return Buffer.from(base64, 'base64');
  }
}
