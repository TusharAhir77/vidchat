from flask import Flask, render_template, request
import os

# Set relative paths so Flask locates templates and static files from root directory on Vercel
template_dir = os.path.abspath(os.path.join(os.path.dirname(__file__), '..', 'templates'))
static_dir = os.path.abspath(os.path.join(os.path.dirname(__file__), '..', 'static'))

app = Flask(__name__, template_folder=template_dir, static_folder=static_dir)
app.config['SECRET_KEY'] = 'videochat_secret_key_2026'

@app.route('/')
@app.route('/<path:path>')
def index(path=None):
    return render_template('index.html')

if __name__ == '__main__':
    app.run(host='0.0.0.0', port=5000, debug=True)
