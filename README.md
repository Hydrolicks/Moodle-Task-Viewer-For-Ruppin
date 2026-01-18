# Moodle Task Viewer for Ruppin 

Moodle Task Viewer for Ruppin is a Google Chrome extension designed to improve the academic workflow of students at Ruppin Academic Center by providing a clear, accessible, and efficient task-tracking panel directly inside the Moodle platform.

The extension helps students monitor assignments, deadlines, and task statuses without navigating through multiple Moodle pages, making academic task management simpler and more intuitive.

---

## Features

- Displays academic tasks and assignments directly from Moodle  
- Embedded side panel for quick access while browsing courses  
- Helps track deadlines and submission status  
- Clean and lightweight user interface  
- Runs automatically when visiting the Ruppin Moodle website  
- No external servers or data storage – runs locally in the browser  

---

## Motivation

While Moodle is a powerful Learning Management System, tracking assignments often requires navigating multiple sections and pages.  
This extension was built to centralize task visibility, reduce friction, and help students stay organized and on top of their academic responsibilities.

---

## Project Structure

Moodle-Task-Viewer-For-Ruppin/  
├── manifest.json        Chrome extension configuration  
├── content.js           Content script that interacts with Moodle pages  
├── styles.css           Styling for the task panel UI  
├── icon16.png           Extension icons  
├── icon48.png  
├── icon128.png  

---

## Installation (Chrome Web Store – Recommended)

The simplest way to install Moodle Task Viewer for Ruppin is directly from the Chrome Web Store.

Open the extension page on the Chrome Web Store:
👉 [Install from Chrome Web Store](https://chromewebstore.google.com/detail/moodle-task-viewer/mdcaplopjndbjjohkeamogegcnjfogpe?hl=iw)

Click “Add to Chrome”.

Confirm by clicking “Add extension”.

Open the Ruppin Moodle website – the task viewer panel will appear automatically.

Make sure the ORIGINAL assignments view is set to "Sort By Date / מיין לפי תאריך" and the assignments list is set to "all / הכל".

---

## Installation (Developer Mode)

1. Clone the repository:

   git clone https://github.com/Hydrolicks/Moodle-Task-Viewer-For-Ruppin.git

2. Open Google Chrome and navigate to:

   chrome://extensions

3. Enable Developer Mode (top-right corner).

4. Click Load unpacked and select the project folder.

5. Open the Ruppin Moodle website – the task viewer panel will appear automatically.

6. Make sure the ORIGINAL assignments view is set to "Sort By Date / מיין לפי תאריך" and the assignments list is set to "all / הכל"
   


---

## How It Works

- The extension injects a content script into Moodle pages  
- Relevant task and assignment data is extracted from the page structure  
- A custom UI panel is rendered on top of the Moodle interface  
- Styling is handled via a dedicated CSS file to keep the UI minimal and unobtrusive  

---

## Future Improvements

- Notifications for upcoming or overdue assignments  
- Google Calendar integration  
- Filtering by course or task status  
- User settings panel  
- Task completion analytics  

---

## ⚠️ Disclaimer

This project is not an official Moodle or Ruppin Academic Center product.  
It is an independent student-developed tool intended for educational and personal productivity purposes.

---

## License

This project is open-source.
  
© 2025 Hydrolicks - Asaf Amrani

---

## Contributions

Contributions, suggestions, and bug reports are welcome.  
Feel free to open an issue or submit a pull request.

---

## Acknowledgments

Built with the goal of improving the student experience and learning efficiency at Ruppin Academic Center.
