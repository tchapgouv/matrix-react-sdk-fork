
//is duplicated from matrix-react-sdk/test/setupTests.js in order to work
import Adapter from "@wojtekmaj/enzyme-adapter-react-17";
import { configure } from "enzyme";
configure({ adapter: new Adapter() });