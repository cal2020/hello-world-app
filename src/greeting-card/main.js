import './style.css'
import { setupCardGenerator } from './card-generator.js'

document.querySelector('#app').innerHTML = `
  <div class="app-container">
    <header class="app-header">
      <h1>💌 Greeting Card Generator</h1>
      <p>Create beautiful personalized greeting cards</p>
    </header>

    <div class="main-content">
      <div class="form-section">
        <h2>Card Details</h2>
        <form id="card-form">
          <div class="input-group">
            <label for="recipient">To:</label>
            <input type="text" id="recipient" placeholder="Recipient's name" />
          </div>

          <div class="input-group">
            <label for="sender">From:</label>
            <input type="text" id="sender" placeholder="Your name" />
          </div>

          <div class="input-group">
            <label for="occasion">Occasion:</label>
            <select id="occasion">
              <option value="birthday">Birthday</option>
              <option value="anniversary">Anniversary</option>
              <option value="thank-you">Thank You</option>
              <option value="congratulations">Congratulations</option>
              <option value="holiday">Holiday</option>
              <option value="custom">Custom</option>
            </select>
          </div>

          <div class="input-group">
            <label for="message">Message:</label>
            <textarea id="message" placeholder="Write your personal message here..." rows="4"></textarea>
          </div>

          <div class="input-group">
            <label for="theme">Theme:</label>
            <select id="theme">
              <option value="classic">Classic</option>
              <option value="modern">Modern</option>
              <option value="elegant">Elegant</option>
              <option value="playful">Playful</option>
            </select>
          </div>
        </form>
      </div>

      <div class="preview-section">
        <h2>Preview</h2>
        <div id="card-preview" class="card-preview">
          <div class="card-content">
            <div class="card-header">
              <span class="occasion-text">Happy Birthday!</span>
            </div>
            <div class="card-message">
              <p>Your message will appear here...</p>
            </div>
            <div class="card-footer">
              <span class="card-from">From: </span>
              <span class="card-to">To: </span>
            </div>
          </div>
        </div>

        <div class="actions">
          <button id="download-btn" class="btn btn-primary">Download Card</button>
          <button id="reset-btn" class="btn btn-secondary">Reset</button>
        </div>
      </div>
    </div>
  </div>
`

setupCardGenerator()
